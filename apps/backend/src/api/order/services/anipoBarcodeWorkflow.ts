import { effectiveOrderDeliveryAddress } from "../../../utils/orderDeliverySnapshot";
import type { Strapi } from "@strapi/strapi";
import { logAdminBarcodeOperation } from "../../../utils/adminActivity";
import { writeAuditEvent } from "../../../audit/writer";
import { runBackgroundJob } from "../../../jobs/backgroundJobRunner";
import {
  mapOrderStatusToAnipo,
  parseAnipoOrderResult,
  type AnipoCreateOrderPayload,
  type AnipoOrderResult,
  type AnipoBatchBarcodeResult,
  type AnipoApiResult,
} from "../../shipping/services/anipo";
import { enqueueAnipoRegistration } from "../../../queue/anipo-registration";
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
  barcodes?: string[];
  expectedCount?: number;
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
  ) => Promise<AnipoApiResult<unknown>>;
  getOrder: (
    orderCode: string,
  ) => Promise<AnipoApiResult<AnipoOrderResult>>;
  getOrderBarcodes: (
    orderCodes: string[],
  ) => Promise<AnipoApiResult<AnipoBatchBarcodeResult[]>>;
};

type SubmitOptions = {
  weight?: unknown;
  boxSizeId?: unknown;
  weightFromItems?: boolean;
  actor?: AnipoWorkflowActor;
  now?: Date;
  forceRetry?: boolean;
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

type StoredBarcodeData = { expectedCount: number; barcodes: string[] };

function barcodeData(order: any, provider?: AnipoOrderResult): StoredBarcodeData {
  const stored = order?.AnipoBarcodeData;
  const prior = Array.isArray(stored?.barcodes) ? stored.barcodes : [];
  const codes = [order?.ShippingBarcode, ...prior, provider?.barcode, ...(provider?.barcodes || [])]
    .filter((code): code is string => typeof code === "string" && Boolean(code.trim()))
    .map((code) => code.trim());
  const unique = [...new Set(codes)];
  const expectedCount = Math.max(
    1,
    Number(stored?.expectedCount) || 0,
    Number(provider?.expectedCount) || 0,
    unique.length,
  );
  return { expectedCount, barcodes: unique };
}

function safeError(error: unknown): string {
  return String(error || "provider_error")
    .replace(/(?:[0-9۰-۹٠-٩][\s().-]*){8,}/g, "[redacted]")
    .replace(/["'«][^"'»]{8,}["'»]/g, "[redacted]")
    .slice(0, 500);
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
  const stored = barcodeData(order);
  return {
    success: true,
    state,
    issued: state === ANIPO_BARCODE_STATES.issued && Boolean(barcode),
    pending: state === ANIPO_BARCODE_STATES.pending,
    barcode,
    barcodes: stored.barcodes,
    expectedCount: stored.expectedCount,
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
  return { ...order, delivery_address: await effectiveOrderDeliveryAddress(strapi, Number(order.id), order.delivery_address) };
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
  if (order.reserve_shipment?.id) {
    const { submitReserveParcel } = await import("./anipoReserveParcel");
    return submitReserveParcel(strapi, Number(order.reserve_shipment.id), options);
  }
  if (order.AnipoBarcodeState === ANIPO_BARCODE_STATES.issued ||
      (order.ShippingBarcode && !order.AnipoBarcodeState)) {
    return responseFromOrder(
      { ...order, AnipoBarcodeState: ANIPO_BARCODE_STATES.issued },
      { already: true },
    );
  }
  if ((order.AnipoBarcodeState === ANIPO_BARCODE_STATES.pending && order.AnipoSubmittedAt) ||
      (order.AnipoBarcodeState === ANIPO_BARCODE_STATES.needsAttention && !options.forceRetry)) {
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
  // ShippingWeight is only a checkout snapshot until registration, so the
  // automatic path re-weighs from the products as they are now: weights staff
  // enter after checkout still count.
  const packageData = resolveAnipoPackage(
    order,
    options.weightFromItems
      ? { ...options, weight: computeProductWeight(order.order_items || []) }
      : options,
  );
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
    package_count: 1,
    box_type: packageData.boxSizeId,
    parcel_content: "پوشاک",
    order_total: computeAnipoOrderTotalIrr(order),
    order_status: mapOrderStatusToAnipo(order.Status),
  });
  if (!createResult?.ok) {
    const details = createResult.validationErrors
      ? Object.entries(createResult.validationErrors)
          .map(([field, errors]) => `${field}: ${errors.join("، ")}`)
          .join("؛ ")
      : "";
    const message = createResult.status === 401
      ? "تنظیمات اتصال آنیپو نامعتبر است"
      : createResult.status === 422
        ? details || "اطلاعات سفارش برای آنیپو نامعتبر است"
        : `ارتباط با آنیپو ناموفق بود (${createResult.status || "network"})`;
    throw new AnipoWorkflowError(
      createResult.status || 502,
      "ANIPO_REGISTER_ERROR",
      safeError(message),
    );
  }

  // Registration succeeds without a barcode. The scheduled batch poller picks
  // it up later; there is no immediate per-order GET after every POST.
  const provider = parseAnipoOrderResult(createResult.data) || undefined;
  const data = barcodeData(order, provider);
  const barcode = data.barcodes[0];
  const state = provider?.issued && data.barcodes.length >= data.expectedCount
    ? ANIPO_BARCODE_STATES.issued : ANIPO_BARCODE_STATES.pending;
  const updateData: Record<string, unknown> = {
    ShippingWeight: packageData.weight,
    ShippingBoxSizeId: packageData.boxSizeId,
    AnipoBarcodeState: state,
    AnipoSubmittedAt: now,
    AnipoLastCheckedAt: now,
    AnipoPollingDeadlineAt: deadline,
    AnipoCheckCount: 0,
    AnipoLastError: null,
    AnipoBarcodeData: data,
    ...providerStateData(provider),
  };
  if (barcode) {
    updateData.ShippingBarcode = barcode;
  }
  if (state === ANIPO_BARCODE_STATES.issued) {
    updateData.AnipoIssuedAt = asDate(provider?.issuedAt) || now;
  }
  const updated = await strapi.db.transaction(async ({ trx }) => {
    const persisted = await strapi.db.query("api::order.order").update({
      where: {
        id: orderId,
        AnipoBarcodeState: order.AnipoBarcodeState || { $null: true },
        AnipoSubmittedAt: order.AnipoSubmittedAt || { $null: true },
      },
      data: updateData,
      transacting: trx,
    } as any);
    if (persisted && barcode && state === ANIPO_BARCODE_STATES.issued) {
      await propagateBarcodeToReserveGroup(strapi, order, orderId, barcode, trx);
      await recordIssuedAudit(strapi, orderId, barcode, options.actor);
    }
    return persisted;
  });
  return responseFromOrder(updated || (await loadOrder(strapi, orderId)));
}

export async function refreshAnipoBarcodeStatus(
  strapi: Strapi,
  orderId: number,
  options: RefreshOptions,
): Promise<AnipoWorkflowResponse> {
  const order = await loadOrder(strapi, orderId);
  if (order.reserve_shipment?.id) {
    const { refreshReserveParcel } = await import("./anipoReserveParcel");
    return refreshReserveParcel(strapi, Number(order.reserve_shipment.id), options.actor);
  }
  if (order.AnipoBarcodeState === ANIPO_BARCODE_STATES.issued ||
      (order.ShippingBarcode && !order.AnipoBarcodeState)) {
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
    const missing = providerResult?.status === 404;
    await strapi.db.query("api::order.order").update({
      where: { id: orderId, AnipoBarcodeState: order.AnipoBarcodeState },
      data: {
        ...(missing ? { AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention } : {}),
        AnipoLastCheckedAt: now,
        AnipoCheckCount: nextCheckCount,
        AnipoLastError: missing ? "ANIPO_REMOTE_ORDER_NOT_FOUND" : safeError(providerResult?.error || "status_check_failed"),
      },
    });
    throw new AnipoWorkflowError(
      502,
      "ANIPO_STATUS_ERROR",
      providerResult?.error || "دریافت وضعیت بارکد از آنیپو ناموفق بود",
    );
  }

  const provider = providerResult.data;
  const data = barcodeData(order, provider);
  const barcode = data.barcodes[0];
  const complete = Boolean(provider.issued && data.barcodes.length >= data.expectedCount);
  const state = complete
    ? ANIPO_BARCODE_STATES.issued
    : order.AnipoBarcodeState === ANIPO_BARCODE_STATES.needsAttention
      ? ANIPO_BARCODE_STATES.needsAttention
      : ANIPO_BARCODE_STATES.pending;
  const updateData: Record<string, unknown> = {
    AnipoBarcodeState: state,
    AnipoLastCheckedAt: now,
    AnipoCheckCount: nextCheckCount,
    AnipoLastError: null,
    AnipoBarcodeData: data,
    ...providerStateData(provider),
  };
  if (barcode) {
    updateData.ShippingBarcode = barcode;
  }
  if (complete) {
    updateData.AnipoIssuedAt = asDate(provider.issuedAt) || now;
  }
  const updated = await strapi.db.transaction(async ({ trx }) => {
    const persisted = await strapi.db.query("api::order.order").update({
      where: {
        id: orderId,
        AnipoBarcodeState: order.AnipoBarcodeState,
      },
      data: updateData,
      transacting: trx,
    } as any);
    if (complete && barcode && persisted) {
      await propagateBarcodeToReserveGroup(strapi, order, orderId, barcode, trx);
      await recordIssuedAudit(strapi, orderId, barcode, options.actor);
    }
    return persisted;
  });
  const authoritative = updated || (await loadOrder(strapi, orderId));
  return responseFromOrder(authoritative);
}

export async function recordAnipoRegistrationFailure(
  strapi: Strapi,
  orderId: number,
  error: unknown,
  final: boolean,
  allowSubmitted = false,
): Promise<boolean> {
  const message = safeError(error instanceof Error ? error.message : error);
  const current = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    select: ["AnipoCheckCount", "AnipoBarcodeState"],
  });
  // Before submission this existing counter tracks registration attempts; a
  // successful POST resets it, after which it tracks barcode checks again.
  const attempts = Math.max(0, Number(current?.AnipoCheckCount || 0)) + 1;
  const terminal = final || attempts >= 5;
  await strapi.db.query("api::order.order").update({
    where: {
      id: orderId,
      AnipoBarcodeState: current?.AnipoBarcodeState
        ? { $in: [ANIPO_BARCODE_STATES.pending, ANIPO_BARCODE_STATES.needsAttention] }
        : { $null: true },
      ...(allowSubmitted ? {} : { AnipoSubmittedAt: { $null: true } }),
    },
    data: {
      AnipoLastError: message,
      AnipoLastCheckedAt: new Date(),
      AnipoCheckCount: attempts,
      ...(terminal ? { AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention } : {}),
    },
  });
  strapi.log.error("Anipo registration attempt failed", {
    orderId,
    status: error instanceof AnipoWorkflowError ? error.status : null,
    final: terminal,
    error: message,
  });
  return terminal;
}

export async function processAnipoRegistrationJob(
  strapi: Strapi,
  orderId: number,
  attempt: number,
  maxAttempts: number,
): Promise<AnipoWorkflowResponse | { skipped: true }> {
  const row = await strapi.db.query("api::order.order").findOne({
    where: { id: orderId },
    select: ["id", "Status", "AnipoBarcodeState", "AnipoSubmittedAt", "ShippingBarcode"],
    populate: { reserve_shipment: { select: ["id"] } },
  });
  if (row?.reserve_shipment?.id) {
    const { submitReserveParcel } = await import("./anipoReserveParcel");
    return submitReserveParcel(strapi, Number(row.reserve_shipment.id), { weightFromItems: true, boxSizeId: 3 });
  }
  if (!row || row.Status !== "Shipment" || row.AnipoSubmittedAt || row.ShippingBarcode ||
      row.AnipoBarcodeState !== ANIPO_BARCODE_STATES.pending) return { skipped: true };
  try {
    return await submitAnipoBarcode(strapi, orderId, { weightFromItems: true, boxSizeId: 3 });
  } catch (error) {
    const status = error instanceof AnipoWorkflowError ? error.status : 0;
    const retryable = !status || status === 408 || status === 429 || status >= 500;
    const final = !retryable || attempt >= maxAttempts;
    const terminal = await recordAnipoRegistrationFailure(strapi, orderId, error, final);
    if (!terminal) throw error;
    return { skipped: true };
  }
}

async function applyAnipoBatchResult(
  strapi: Strapi,
  row: any,
  result: AnipoBatchBarcodeResult,
  now: Date,
): Promise<AnipoBarcodeState> {
  const query = strapi.db.query("api::order.order");
  if (!result.found) {
    await query.update({
      where: { id: row.id, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
      data: {
        AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention,
        AnipoLastCheckedAt: now,
        AnipoLastError: "ANIPO_REMOTE_ORDER_NOT_FOUND",
      },
    });
    return ANIPO_BARCODE_STATES.needsAttention;
  }
  const data = barcodeData(row, result);
  const complete = result.issued && data.barcodes.length >= data.expectedCount;
  const barcode = data.barcodes[0];
  const updated = await query.update({
    where: { id: row.id, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
    data: {
      AnipoBarcodeState: complete ? ANIPO_BARCODE_STATES.issued : ANIPO_BARCODE_STATES.pending,
      AnipoBarcodeData: data,
      ...(barcode ? { ShippingBarcode: barcode } : {}),
      ...(complete ? { AnipoIssuedAt: asDate(result.issuedAt) || now } : {}),
      AnipoLastCheckedAt: now,
      AnipoCheckCount: Number(row.AnipoCheckCount || 0) + 1,
      AnipoLastError: null,
      ...providerStateData(result),
    },
  });
  if (complete && barcode && updated) {
    const fullOrder = await loadOrder(strapi, Number(row.id));
    await propagateBarcodeToReserveGroup(strapi, fullOrder, Number(row.id), barcode);
    await recordIssuedAudit(strapi, Number(row.id), barcode);
  }
  return complete ? ANIPO_BARCODE_STATES.issued : ANIPO_BARCODE_STATES.pending;
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
      const query = strapi.db.query("api::order.order");
      const now = new Date();
      const sevenDaysAgo = new Date(now.getTime() - POLLING_WINDOW_MS);
      const postalShipment = {
        reserve_shipment: { id: { $null: true } },
        Status: "Shipment",
        $or: [{ ShippingMethodCode: "post" }, { shipping: { Code: "post" } }],
      };
      const unsubmitted = await query.findMany({
        where: { ...postalShipment, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending, AnipoSubmittedAt: { $null: true } },
        select: ["id"],
        limit: batchSize,
      });
      for (const row of unsubmitted) {
        try {
          await enqueueAnipoRegistration(Number(row.id));
        } catch (error) {
          strapi.log.error("Anipo registration recovery enqueue failed", {
            orderId: row.id,
            error: safeError(error instanceof Error ? error.message : error),
          });
          try {
            await recordAnipoRegistrationFailure(strapi, Number(row.id), error, false);
          } catch (recordError) {
            strapi.log.error("Anipo recovery state update failed", {
              orderId: row.id,
              error: safeError(recordError instanceof Error ? recordError.message : recordError),
            });
          }
        }
      }

      const expired = await query.findMany({
        where: {
          $and: [
            postalShipment,
            { $or: [
              { AnipoPollingDeadlineAt: { $lte: now } },
              { AnipoPollingDeadlineAt: { $null: true }, AnipoSubmittedAt: { $lte: sevenDaysAgo } },
            ] },
          ],
          AnipoBarcodeState: ANIPO_BARCODE_STATES.pending,
          AnipoSubmittedAt: { $notNull: true },
        },
        select: ["id"],
        limit: batchSize,
      });
      let failed = 0;
      let needsAttention = 0;
      for (const row of expired) {
        try {
          await query.update({
            where: { id: row.id, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
            data: {
              AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention,
              AnipoLastMessage: "مهلت هفت‌روزه پیگیری خودکار آنیپو تمام شد",
            },
          });
          needsAttention += 1;
        } catch (error) {
          failed += 1;
          strapi.log.error("Anipo barcode expiry update failed", {
            orderId: row.id,
            error: safeError(error instanceof Error ? error.message : error),
          });
        }
      }

      const rows = await query.findMany({
        where: {
          $and: [
            postalShipment,
            { $or: [
              { AnipoPollingDeadlineAt: { $gt: now } },
              { AnipoPollingDeadlineAt: { $null: true }, AnipoSubmittedAt: { $gt: sevenDaysAgo } },
            ] },
          ],
          AnipoBarcodeState: ANIPO_BARCODE_STATES.pending,
          AnipoSubmittedAt: { $notNull: true },
        },
        select: ["id", "ShippingBarcode", "AnipoBarcodeData", "AnipoCheckCount"],
        orderBy: [{ AnipoLastCheckedAt: "asc" }, { id: "asc" }],
        limit: batchSize,
      });
      let processed = 0;
      let issued = 0;
      const anipo = rows.length > 0
        ? strapi.service("api::shipping.anipo") as AnipoService
        : null;
      for (let offset = 0; offset < rows.length; offset += 200) {
        const chunk = rows.slice(offset, offset + 200);
        let response: AnipoApiResult<AnipoBatchBarcodeResult[]>;
        try {
          response = await anipo!.getOrderBarcodes(chunk.map((row: any) => String(row.id)));
        } catch (error) {
          failed += chunk.length;
          strapi.log.error("Anipo barcode batch request failed", {
            count: chunk.length,
            error: safeError(error instanceof Error ? error.message : error),
          });
          continue;
        }
        if (!response.ok || !response.data) {
          failed += chunk.length;
          if (response.status === 401 || response.status === 422) {
            for (const row of chunk) {
              try {
                await query.update({
                  where: { id: row.id, AnipoBarcodeState: ANIPO_BARCODE_STATES.pending },
                  data: { AnipoBarcodeState: ANIPO_BARCODE_STATES.needsAttention, AnipoLastError: response.status === 401 ? "تنظیمات اتصال آنیپو نامعتبر است" : "پاسخ آنیپو برای استعلام بارکد نامعتبر است" },
                });
                needsAttention += 1;
              } catch (error) {
                strapi.log.error("Anipo barcode review update failed", {
                  orderId: row.id,
                  error: safeError(error instanceof Error ? error.message : error),
                });
              }
            }
          }
          continue;
        }
        const byCode = new Map(response.data.map((result) => [result.orderCode, result]));
        for (const row of chunk) {
          const result = byCode.get(String(row.id));
          if (!result) {
            failed += 1;
            continue;
          }
          try {
            const state = await applyAnipoBatchResult(strapi, row, result, now);
            processed += 1;
            if (state === ANIPO_BARCODE_STATES.issued) issued += 1;
            if (state === ANIPO_BARCODE_STATES.needsAttention) needsAttention += 1;
          } catch (error) {
            failed += 1;
            strapi.log.error("Anipo barcode result failed", {
              orderId: row.id,
              error: safeError(error instanceof Error ? error.message : error),
            });
          }
        }
      }
      return {
        scanned: rows.length,
        processed,
        issued,
        needsAttention,
        stopped: 0,
        failed,
        parcelsProcessed: (await (await import("./anipoReserveParcel")).runReserveParcelReconciliation(strapi)).processed,
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
