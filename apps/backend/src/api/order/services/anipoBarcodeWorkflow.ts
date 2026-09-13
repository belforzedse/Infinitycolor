import type { Strapi } from "@strapi/strapi";
import { logAdminBarcodeOperation } from "../../../utils/adminActivity";
import { writeAuditEvent } from "../../../audit/writer";
import { runBackgroundJob } from "../../../jobs/backgroundJobRunner";
import {
  mapOrderStatusToAnipo,
  type AnipoCreateOrderPayload,
  type AnipoOrderResult,
} from "../../shipping/services/anipo";
import { buildAnipoOrderRecipient } from "../controllers/helpers/anipoOrder";
import {
  claimGroupShippingBarcode,
  findGroupShippingBarcode,
  HELD_RESERVE_STATES,
} from "../../reserve-group/lib/reserve-group";

export const ANIPO_BARCODE_STATES = {
  pending: "Pending",
  issued: "Issued",
  needsAttention: "NeedsAttention",
  stopped: "Stopped",
  voided: "Voided",
} as const;

export type AnipoBarcodeState =
  (typeof ANIPO_BARCODE_STATES)[keyof typeof ANIPO_BARCODE_STATES];

export type AnipoWorkflowActor = {
  id: number;
  ip?: string | null;
  userAgent?: string | null;
  roleName?: string;
};

export type AnipoWorkflowResponse = {
  success: true;
  state: AnipoBarcodeState;
  issued: boolean;
  pending: boolean;
  already?: boolean;
  barcode?: string;
  readyToIssue?: boolean;
  providerStatus?: string;
  message: string;
  submittedAt?: string;
  lastCheckedAt?: string;
  pollingDeadlineAt?: string;
  data?: { barcode: string; weight_g?: number; box_type?: number };
};

type AnipoService = {
  createOrUpdateOrder: (
    payload: AnipoCreateOrderPayload,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  getOrder: (
    orderCode: string,
  ) => Promise<{ ok: boolean; data?: AnipoOrderResult; error?: string }>;
};

type SubmitOptions = {
  weight?: unknown;
  boxSizeId?: unknown;
  actor?: AnipoWorkflowActor;
  now?: Date;
};

type RefreshOptions = {
  source: "admin" | "scheduler";
  actor?: AnipoWorkflowActor;
  now?: Date;
};

// A barcode is issued while the order is being prepared or once it is completed,
// and stays pollable after it ships. Fulfilment is Started -> Done -> Shipment,
// so `Done` sits between the other two and must be eligible as well.
const ELIGIBLE_STATUSES = new Set(["Started", "Done", "Shipment"]);
const POLLING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export class AnipoWorkflowError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AnipoWorkflowError";
  }
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
}

function computeProductWeight(orderItems: unknown[]): number {
  let weight = 0;
  for (const itemValue of orderItems || []) {
    const item = itemValue as {
      Count?: number;
      product_variation?: { product?: { Weight?: number } };
    };
    const productWeight = Number(item?.product_variation?.product?.Weight ?? 100) || 100;
    weight += productWeight * Math.max(0, Number(item?.Count || 0));
  }
  return weight > 0 ? Math.round(weight) : 100;
}

export function computeAnipoOrderTotalIrr(order: any): number {
  const contractAmountToman = Number(order?.contract?.Amount);
  if (order?.contract && Number.isFinite(contractAmountToman) && contractAmountToman >= 0) {
    return Math.round(contractAmountToman * 10);
  }

  const subtotal = (order?.order_items || []).reduce(
    (sum: number, item: any) =>
      sum + Number(item?.PerAmount || 0) * Math.max(0, Number(item?.Count || 0)),
    0,
  );
  const totalToman = Math.max(
    0,
    subtotal - Number(order?.AppliedDiscountAmount || 0) + Number(order?.ShippingCost || 0),
  );
  return Math.round(totalToman * 10);
}

export function resolveAnipoPackage(
  order: any,
  input: { weight?: unknown; boxSizeId?: unknown },
): { weight: number; boxSizeId: number } {
  const hasWeightInput = input.weight !== undefined && input.weight !== null && input.weight !== "";
  const requestedWeight = Number(input.weight);
  if (hasWeightInput && (!Number.isInteger(requestedWeight) || requestedWeight <= 0)) {
    throw new AnipoWorkflowError(422, "ANIPO_INVALID_WEIGHT", "وزن باید یک عدد صحیح مثبت باشد");
  }

  const storedWeight = Number(order?.ShippingWeight || 0);
  const weight = hasWeightInput
    ? requestedWeight
    : Number.isInteger(storedWeight) && storedWeight > 0
      ? storedWeight
      : computeProductWeight(order?.order_items || []);

  const hasBoxInput =
    input.boxSizeId !== undefined && input.boxSizeId !== null && input.boxSizeId !== "";
  const requestedBox = Number(input.boxSizeId);
  if (hasBoxInput && (!Number.isInteger(requestedBox) || requestedBox < 1 || requestedBox > 10)) {
    throw new AnipoWorkflowError(
      422,
      "ANIPO_INVALID_BOX_SIZE",
      "سایز جعبه باید عددی بین ۱ تا ۱۰ باشد",
    );
  }

  const storedBox = Number(order?.ShippingBoxSizeId || 0);
  const boxSizeId = hasBoxInput
    ? requestedBox
    : Number.isInteger(storedBox) && storedBox >= 1 && storedBox <= 10
      ? storedBox
      : 3;

  return { weight, boxSizeId };
}

function workflowMessage(state: AnipoBarcodeState, providerMessage?: string): string {
  if (state === ANIPO_BARCODE_STATES.issued) return "بارکد آنیپو صادر شد";
  if (state === ANIPO_BARCODE_STATES.needsAttention) {
    return providerMessage || "صدور بارکد بیش از هفت روز در انتظار مانده و نیاز به بررسی دارد";
  }
  if (state === ANIPO_BARCODE_STATES.stopped) {
    return "پیگیری خودکار بارکد برای وضعیت فعلی سفارش متوقف شد";
  }
  if (state === ANIPO_BARCODE_STATES.voided) return "بارکد در سایت باطل شده است";
  return providerMessage || "سفارش در آنیپو ثبت شد و در انتظار تأیید اپراتور است";
}

function responseFromOrder(order: any, overrides: Partial<AnipoWorkflowResponse> = {}): AnipoWorkflowResponse {
  const state = (order?.AnipoBarcodeState || ANIPO_BARCODE_STATES.pending) as AnipoBarcodeState;
  const barcode = text(order?.ShippingBarcode);
  return {
    success: true,
    state,
    issued: state === ANIPO_BARCODE_STATES.issued && Boolean(barcode),
    pending: state === ANIPO_BARCODE_STATES.pending,
    barcode,
    readyToIssue:
      typeof order?.AnipoReadyToIssue === "boolean" ? order.AnipoReadyToIssue : undefined,
    providerStatus: text(order?.AnipoProviderStatus),
    message: workflowMessage(state, text(order?.AnipoLastMessage)),
    submittedAt: asDate(order?.AnipoSubmittedAt)?.toISOString(),
    lastCheckedAt: asDate(order?.AnipoLastCheckedAt)?.toISOString(),
    pollingDeadlineAt: asDate(order?.AnipoPollingDeadlineAt)?.toISOString(),
    ...(barcode
      ? {
          data: {
            barcode,
            weight_g: Number(order?.ShippingWeight || 0) || undefined,
            box_type: Number(order?.ShippingBoxSizeId || 0) || undefined,
          },
        }
      : {}),
    ...overrides,
  };
}

async function loadOrder(strapi: Strapi, orderId: number): Promise<any> {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new AnipoWorkflowError(422, "ANIPO_INVALID_ORDER_ID", "شناسه سفارش نامعتبر است");
  }
  const order = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    populate: {
      user: { populate: { user_info: true } },
      shipping: true,
      contract: true,
      reserve_shipment: true,
      delivery_address: {
        populate: { shipping_city: { populate: { shipping_province: true } } },
      },
      order_items: { populate: { product_variation: { populate: { product: true } } } },
    },
  });
  if (!order) throw new AnipoWorkflowError(404, "ANIPO_ORDER_NOT_FOUND", "سفارش پیدا نشد");
  return order;
}

/**
 * True while the order's combined-shipping window is still open.
 *
 * Barcode issuance is the sharpest edge in this feature: the reconcile job runs
 * unattended, so a held parcel could otherwise get a courier label with no admin
 * involved at all.
 */
function isHeldByReserveWindow(order: any): boolean {
  const state = String(order?.reserve_shipment?.State || "");
  return HELD_RESERVE_STATES.includes(state as never);
}

function assertSubmissionEligibility(order: any): void {
  if (isHeldByReserveWindow(order)) {
    throw new AnipoWorkflowError(
      409,
      "ANIPO_RESERVE_HOLD",
      "این سفارش در مهلت رزرو ۴۸ ساعته است و تا پایان مهلت بارکد صادر نمی‌شود",
    );
  }

  const shippingCode = text(order?.ShippingMethodCode || order?.shipping?.Code)?.toLowerCase();
  if (shippingCode !== "post") {
    throw new AnipoWorkflowError(
      409,
      "ANIPO_INELIGIBLE_SHIPPING",
      "صدور بارکد آنیپو فقط برای سفارش‌های روش ارسال پستی مجاز است",
    );
  }
  if (!ELIGIBLE_STATUSES.has(String(order?.Status || ""))) {
    throw new AnipoWorkflowError(
      409,
      "ANIPO_INELIGIBLE_STATUS",
      "صدور بارکد آنیپو فقط برای سفارش پرداخت‌شده در حال آماده‌سازی، تکمیل شده یا ارسال مجاز است",
    );
  }
}

function validateRecipient(order: any) {
  const recipient = buildAnipoOrderRecipient(order);
  if (!recipient.provinceName || !recipient.cityName) {
    throw new AnipoWorkflowError(
      422,
      "ANIPO_MISSING_PROVINCE_CITY",
      "نام استان یا شهر برای آنیپو ناقص است",
    );
  }
  if (!recipient.mobile) {
    throw new AnipoWorkflowError(
      422,
      "ANIPO_MISSING_MOBILE",
      "موبایل گیرنده برای صدور بارکد آنیپو لازم است",
    );
  }
  if (!recipient.fullAddress) {
    throw new AnipoWorkflowError(
      422,
      "ANIPO_MISSING_ADDRESS",
      "نشانی گیرنده برای صدور بارکد آنیپو لازم است",
    );
  }
  return recipient;
}

function providerStateData(provider: AnipoOrderResult | undefined) {
  return {
    AnipoReadyToIssue:
      typeof provider?.readyToIssue === "boolean" ? provider.readyToIssue : null,
    AnipoProviderStatus: provider?.status || null,
    AnipoLastMessage: provider?.message || null,
  };
}

async function recordIssuedAudit(
  strapi: Strapi,
  orderId: number,
  barcode: string,
  actor?: AnipoWorkflowActor,
) {
  if (actor?.id) {
    await logAdminBarcodeOperation(
      strapi,
      orderId,
      "generate",
      actor.id,
      barcode,
      undefined,
      actor.ip,
      actor.userAgent,
      actor.roleName,
    );
    return;
  }
  await writeAuditEvent(strapi, {
    eventKey: "orders.shipping_changed",
    initiator: { type: "scheduled_job", id: "anipo-reconciliation", label: "Anipo Reconciliation" },
    actor: { type: "scheduled_job", id: "anipo-reconciliation", label: "Anipo Reconciliation" },
    origin: "scheduled_task",
    target: { type: "order", id: orderId, label: `Order ${orderId}` },
    changes: [{ field: "shippingBarcode", label: "بارکد ارسال", from: null, to: barcode }],
    metadata: { provider: "anipo", operation: "automatic_reconciliation" },
    dedupeKey: `anipo-barcode-issued:${orderId}:${barcode}`,
  });
}

/**
 * Records a newly issued barcode against the order's combined shipment and stamps
 * it onto every sibling order that has none, so the tracking number resolves back
 * to each member without a second physical label being printed. A no-op for an
 * order that is not part of a reserve group.
 */
async function propagateBarcodeToReserveGroup(
  strapi: Strapi,
  order: any,
  orderId: number,
  barcode: string,
  trx?: unknown,
): Promise<void> {
  const group = await findGroupShippingBarcode(strapi, order);
  if (!group) return;
  try {
    const result = await claimGroupShippingBarcode(
      strapi,
      { groupId: group.groupId, barcode },
      trx,
    );
    strapi.log.info("Reserve group shipping barcode propagated", {
      orderId,
      groupId: group.groupId,
      barcode: result.barcode,
      claimed: result.claimed,
      ordersStamped: result.ordersStamped,
    });
  } catch (error) {
    // Never fail an issued barcode over propagation: this order's own barcode is
    // already persisted and correct. Note the reconcile job will NOT retry this --
    // `refreshAnipoBarcodeStatus` returns early once the order has a barcode. The
    // siblings stay unstamped until someone submits one of them, which then takes
    // the adopt path above and stamps the whole group. The logged error is the
    // signal to look, so it is deliberately error-level.
    strapi.log.error("Failed to propagate reserve group shipping barcode", {
      orderId,
      groupId: group.groupId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function submitAnipoBarcode(
  strapi: Strapi,
  orderId: number,
  options: SubmitOptions = {},
): Promise<AnipoWorkflowResponse> {
  const order = await loadOrder(strapi, orderId);
  if (order.ShippingBarcode) {
    return responseFromOrder(
      { ...order, AnipoBarcodeState: ANIPO_BARCODE_STATES.issued },
      { already: true },
    );
  }
  if (
    order.AnipoBarcodeState === ANIPO_BARCODE_STATES.pending ||
    order.AnipoBarcodeState === ANIPO_BARCODE_STATES.needsAttention
  ) {
    return responseFromOrder(order, { already: true });
  }
  if (
    order.AnipoBarcodeState === ANIPO_BARCODE_STATES.stopped ||
    order.AnipoBarcodeState === ANIPO_BARCODE_STATES.voided
  ) {
    throw new AnipoWorkflowError(
      409,
      "ANIPO_WORKFLOW_STOPPED",
      workflowMessage(order.AnipoBarcodeState),
    );
  }

  assertSubmissionEligibility(order);

  // One parcel, one label. If this order's combined shipment already has a
  // barcode, adopt it rather than registering a second consignment for a package
  // that will physically leave once.
  const groupBarcode = await findGroupShippingBarcode(strapi, order);
  if (groupBarcode?.barcode) {
    const propagated = await strapi.db.transaction(async ({ trx }) =>
      claimGroupShippingBarcode(
        strapi,
        { groupId: groupBarcode.groupId, barcode: groupBarcode.barcode! },
        trx,
      ),
    );
    strapi.log.info("Adopted existing reserve group barcode", {
      orderId,
      groupId: groupBarcode.groupId,
      barcode: propagated.barcode,
      ordersStamped: propagated.ordersStamped,
    });
    return responseFromOrder(
      {
        ...order,
        ShippingBarcode: propagated.barcode,
        AnipoBarcodeState: ANIPO_BARCODE_STATES.issued,
      },
      { already: true },
    );
  }

  const recipient = validateRecipient(order);
  const packageData = resolveAnipoPackage(order, options);
  const now = options.now ?? new Date();
  const deadline = new Date(now.getTime() + POLLING_WINDOW_MS);
  const anipo = strapi.service("api::shipping.anipo") as AnipoService;
  const createResult = await anipo.createOrUpdateOrder({
    order_code: String(order.id),
    receiver_name: recipient.receiverName,
    receiver_province: recipient.provinceName,
    receiver_city: recipient.cityName,
    receiver_mobile: recipient.mobile,
    receiver_address: recipient.fullAddress,
    receiver_postal_code: recipient.postalCode,
    weight_g: packageData.weight,
    box_type: packageData.boxSizeId,
    parcel_content: "پوشاک",
    order_total: computeAnipoOrderTotalIrr(order),
    order_status: mapOrderStatusToAnipo(order.Status),
  });
  if (!createResult?.ok) {
    throw new AnipoWorkflowError(
      502,
      "ANIPO_REGISTER_ERROR",
      createResult?.error || "ثبت سفارش در آنیپو ناموفق بود",
    );
  }

  const providerResult = await anipo.getOrder(String(order.id));
  const provider = providerResult?.ok ? providerResult.data : undefined;
  const barcode = provider?.issued ? text(provider.barcode) : undefined;
  const state = barcode ? ANIPO_BARCODE_STATES.issued : ANIPO_BARCODE_STATES.pending;
  const updateData: Record<string, unknown> = {
    ShippingWeight: packageData.weight,
    ShippingBoxSizeId: packageData.boxSizeId,
    AnipoBarcodeState: state,
    AnipoSubmittedAt: now,
    AnipoLastCheckedAt: now,
    AnipoPollingDeadlineAt: deadline,
    AnipoCheckCount: 1,
    AnipoLastError: providerResult?.ok ? null : providerResult?.error || "status_check_failed",
    ...providerStateData(provider),
  };
  if (barcode) {
    updateData.ShippingBarcode = barcode;
    updateData.AnipoIssuedAt = asDate(provider?.issuedAt) || now;
  }
  const updated = await strapi.db.transaction(async ({ trx }) => {
    const persisted = await strapi.db.query("api::order.order").update({
      where: { id: orderId },
      data: updateData,
      transacting: trx,
    } as any);
    if (barcode) {
      await propagateBarcodeToReserveGroup(strapi, order, orderId, barcode, trx);
      await recordIssuedAudit(strapi, orderId, barcode, options.actor);
    }
    return persisted;
  });
  return responseFromOrder(updated || { ...order, ...updateData });
}

export async function refreshAnipoBarcodeStatus(
  strapi: Strapi,
  orderId: number,
  options: RefreshOptions,
): Promise<AnipoWorkflowResponse> {
  const order = await loadOrder(strapi, orderId);
  if (order.ShippingBarcode) {
    return responseFromOrder(
      { ...order, AnipoBarcodeState: ANIPO_BARCODE_STATES.issued },
      { already: true },
    );
  }
  if (
    order.AnipoBarcodeState !== ANIPO_BARCODE_STATES.pending &&
    order.AnipoBarcodeState !== ANIPO_BARCODE_STATES.needsAttention
  ) {
    throw new AnipoWorkflowError(
      409,
      "ANIPO_NOT_SUBMITTED",
      "این سفارش درخواست فعال صدور بارکد آنیپو ندارد",
    );
  }

  const now = options.now ?? new Date();
  if (!ELIGIBLE_STATUSES.has(String(order.Status || "")) || isHeldByReserveWindow(order)) {
    const updated = await strapi.db.query("api::order.order").update({
      where: { id: orderId, AnipoBarcodeState: order.AnipoBarcodeState },
      data: {
        AnipoBarcodeState: ANIPO_BARCODE_STATES.stopped,
        AnipoLastCheckedAt: now,
        AnipoLastMessage: "وضعیت فعلی سفارش دیگر اجازه پیگیری خودکار آنیپو را نمی‌دهد",
      },
    });
    return responseFromOrder(updated || (await loadOrder(strapi, orderId)));
  }

  const deadline = asDate(order.AnipoPollingDeadlineAt);
  if (options.source === "scheduler" && deadline && now >= deadline) {
    const updated = await strapi.db.query("api::order.order").update({
      where: { id: orderId, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
      data: {
        AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention,
        AnipoLastCheckedAt: now,
        AnipoLastMessage: "مهلت هفت‌روزه پیگیری خودکار آنیپو تمام شد",
      },
    });
    return responseFromOrder(updated || (await loadOrder(strapi, orderId)));
  }

  const anipo = strapi.service("api::shipping.anipo") as AnipoService;
  const providerResult = await anipo.getOrder(String(order.id));
  const nextCheckCount = Number(order.AnipoCheckCount || 0) + 1;
  if (!providerResult?.ok || !providerResult.data) {
    await strapi.db.query("api::order.order").update({
      where: { id: orderId, AnipoBarcodeState: order.AnipoBarcodeState },
      data: {
        AnipoLastCheckedAt: now,
        AnipoCheckCount: nextCheckCount,
        AnipoLastError: providerResult?.error || "status_check_failed",
      },
    });
    throw new AnipoWorkflowError(
      502,
      "ANIPO_STATUS_ERROR",
      providerResult?.error || "دریافت وضعیت بارکد از آنیپو ناموفق بود",
    );
  }

  const provider = providerResult.data;
  const barcode = provider.issued ? text(provider.barcode) : undefined;
  const state = barcode
    ? ANIPO_BARCODE_STATES.issued
    : order.AnipoBarcodeState === ANIPO_BARCODE_STATES.needsAttention
      ? ANIPO_BARCODE_STATES.needsAttention
      : ANIPO_BARCODE_STATES.pending;
  const updateData: Record<string, unknown> = {
    AnipoBarcodeState: state,
    AnipoLastCheckedAt: now,
    AnipoCheckCount: nextCheckCount,
    AnipoLastError: null,
    ...providerStateData(provider),
  };
  if (barcode) {
    updateData.ShippingBarcode = barcode;
    updateData.AnipoIssuedAt = asDate(provider.issuedAt) || now;
  }
  const updated = await strapi.db.transaction(async ({ trx }) => {
    const persisted = await strapi.db.query("api::order.order").update({
      where: {
        id: orderId,
        ShippingBarcode: { $null: true },
        AnipoBarcodeState: order.AnipoBarcodeState,
      },
      data: updateData,
      transacting: trx,
    } as any);
    if (barcode && persisted) {
      await propagateBarcodeToReserveGroup(strapi, order, orderId, barcode, trx);
      await recordIssuedAudit(strapi, orderId, barcode, options.actor);
    }
    return persisted;
  });
  const authoritative = updated || (await loadOrder(strapi, orderId));
  return responseFromOrder(authoritative);
}

export async function runAnipoBarcodeReconciliation(strapi: Strapi) {
  return runBackgroundJob({
    strapi,
    jobName: "reconcileAnipoBarcodes",
    run: async () => {
      if (String(process.env.ANIPO_BARCODE_RECONCILE_ENABLED || "true").toLowerCase() === "false") {
        return { disabled: true, scanned: 0, processed: 0, issued: 0, failed: 0 };
      }

      const batchSize = Math.max(
        1,
        Math.min(500, Number(process.env.ANIPO_BARCODE_RECONCILE_BATCH_SIZE || 50) || 50),
      );
      const concurrency = Math.max(
        1,
        Math.min(10, Number(process.env.ANIPO_BARCODE_RECONCILE_CONCURRENCY || 3) || 3),
      );
      const rows = (await strapi.db.query("api::order.order").findMany({
        where: { AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
        select: ["id"],
        orderBy: [{ AnipoLastCheckedAt: "asc" }, { id: "asc" }],
        limit: batchSize,
      })) as Array<{ id: number }>;

      let cursor = 0;
      let processed = 0;
      let issued = 0;
      let needsAttention = 0;
      let stopped = 0;
      let failed = 0;
      const work = async () => {
        while (cursor < rows.length) {
          const row = rows[cursor++];
          try {
            const result = await refreshAnipoBarcodeStatus(strapi, Number(row.id), {
              source: "scheduler",
            });
            processed += 1;
            if (result.state === ANIPO_BARCODE_STATES.issued) issued += 1;
            if (result.state === ANIPO_BARCODE_STATES.needsAttention) needsAttention += 1;
            if (result.state === ANIPO_BARCODE_STATES.stopped) stopped += 1;
          } catch (error) {
            failed += 1;
            strapi.log.error("Anipo barcode reconciliation failed for order", {
              orderId: row.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, rows.length || 1) }, work));
      return {
        scanned: rows.length,
        processed,
        issued,
        needsAttention,
        stopped,
        failed,
      };
    },
  });
}

export const __private = {
  ELIGIBLE_STATUSES,
  POLLING_WINDOW_MS,
  computeProductWeight,
  responseFromOrder,
};
