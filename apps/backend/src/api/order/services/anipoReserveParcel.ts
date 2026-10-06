import { randomUUID } from "node:crypto";
import type { Strapi } from "@strapi/strapi";
import {
  HELD_RESERVE_STATES,
  claimGroupShippingBarcode,
} from "../../reserve-group/lib/reserve-group";
import { buildAnipoOrderRecipient } from "../controllers/helpers/anipoOrder";
import {
  mapOrderStatusToAnipo,
  parseAnipoOrderResult,
  type AnipoOrderResult,
} from "../../shipping/services/anipo";
import {
  AnipoWorkflowError,
  computeAnipoOrderTotalIrr,
  resolveAnipoPackage,
  type AnipoWorkflowActor,
  type AnipoWorkflowResponse,
  __private as orderWorkflow,
} from "./anipoBarcodeWorkflow";
import { logAdminBarcodeOperation } from "../../../utils/adminActivity";

const GROUP_UID = "api::reserve-group.reserve-group";
const ORDER_UID = "api::order.order";
const ELIGIBLE = new Set(["Started", "Done", "Shipment"]);
const LEASE_MS = 5 * 60_000;
const POLLING_MS = 7 * 24 * 60 * 60_000;
const CONFLICT = "ANIPO_GROUP_CONFLICT";
const SHARED_FIELDS = [
  "AnipoBarcodeState",
  "AnipoBarcodeData",
  "AnipoSubmittedAt",
  "AnipoRegistrationAttemptedAt",
  "AnipoLastCheckedAt",
  "AnipoPollingDeadlineAt",
  "AnipoIssuedAt",
  "AnipoCheckCount",
  "AnipoReadyToIssue",
  "AnipoProviderStatus",
  "AnipoLastMessage",
  "AnipoLastError",
  "AnipoRecipientRevision",
  "AnipoRecipientSnapshotRevision",
  "AnipoRecipientSyncedRevision",
  "AnipoRecipientSyncState",
  "AnipoRecipientSyncAttempts",
  "AnipoRecipientSyncLastAttemptAt",
  "AnipoRecipientSyncLastError",
  "AnipoRecipientSyncedAt",
  "ShippingWeight",
  "ShippingBoxSizeId",
] as const;
const groupPopulate = {
  owner: { populate: { user_info: true } },
  shipping: true,
  delivery_address: { populate: { shipping_city: { populate: { shipping_province: true } } } },
};
const memberPopulate = {
  reserve_shipment: { select: ["id"] },
  contract: true,
  order_items: { populate: { product_variation: { populate: { product: true } } } },
};
type Parcel = { group: any; members: any[] };
type Lease = { token: string; id: number };
type SubmitOptions = {
  weight?: unknown;
  boxSizeId?: unknown;
  weightFromItems?: boolean;
  forceRetry?: boolean;
  actor?: AnipoWorkflowActor;
};

function column(name: string) {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function safeError(error: unknown) {
  return String(error instanceof Error ? error.message : error || "anipo_error")
    .replace(/(?:[0-9۰-۹٠-٩][\s().-]*){8,}/g, "[redacted]")
    .slice(0, 500);
}
function paidMembers(parcel: Parcel) {
  return parcel.members.filter((member) => ELIGIBLE.has(String(member.Status)));
}

/** Database-only legacy adoption. Ambiguous consignments are never overwritten. */
export function effectiveParcelState(group: any, members: any[]) {
  if (group.AnipoOrderCode || group.AnipoBarcodeState) return { ...group };
  const registered = members.filter(
    (member) => member.AnipoSubmittedAt || member.AnipoRegistrationAttemptedAt,
  );
  const barcodes = new Set<string>(
    [
      group.ShippingBarcode,
      ...members.flatMap((member) => [
        member.ShippingBarcode,
        ...(member.AnipoBarcodeData?.barcodes || []),
      ]),
    ]
      .filter((value) => typeof value === "string" && value.trim())
      .map((value: string) => value.trim()),
  );
  if (registered.length > 1 || barcodes.size > 1) {
    return { ...group, AnipoBarcodeState: "NeedsAttention", AnipoLastError: CONFLICT };
  }
  const legacy = registered[0];
  const adopted: any = { ...group };
  if (legacy) {
    for (const field of SHARED_FIELDS) if (legacy[field] != null) adopted[field] = legacy[field];
    adopted.AnipoOrderCode = String(legacy.id);
    adopted.AnipoRecipientSnapshotRevision = Number(legacy.AnipoRecipientSyncedRevision || 0);
    adopted.AnipoRecipientRevision = Math.max(
      Number(group.AnipoRecipientRevision || 0),
      Number(legacy.AnipoRecipientRevision || 0),
    );
    if (
      group.AnipoRecipientSyncState === "Pending" ||
      Number(group.AnipoRecipientRevision || 0) > Number(legacy.AnipoRecipientSyncedRevision || 0)
    )
      adopted.AnipoRecipientSyncState = "Pending";
  }
  if (barcodes.size === 1) {
    adopted.ShippingBarcode = [...barcodes][0];
    adopted.AnipoBarcodeState = "Issued";
    adopted.AnipoBarcodeData = { expectedCount: 1, barcodes: [...barcodes] };
  }
  return adopted;
}

export function aggregateParcel(parcel: Parcel) {
  const eligible = paidMembers(parcel);
  const group = effectiveParcelState(parcel.group, parcel.members);
  const items = eligible.flatMap((member) => member.order_items || []);
  const goodsIrr = eligible.reduce(
    (sum, member) =>
      sum +
      Math.max(
        0,
        computeAnipoOrderTotalIrr(member) - Math.round(Number(member.ShippingCost || 0) * 10),
      ),
    0,
  );
  return {
    ...group,
    id: Number(group.AnipoOrderCode || eligible[0]?.id || 0),
    Status: eligible.some((member) => member.Status === "Started")
      ? "Started"
      : eligible.some((member) => member.Status === "Done")
        ? "Done"
        : eligible.length
          ? "Shipment"
          : "Cancelled",
    ShippingMethodCode: group.ShippingMethodCode || group.shipping?.Code,
    user: group.owner,
    delivery_address: group.delivery_address,
    order_items: items,
    contract: { Amount: (goodsIrr + Math.round(Number(group.ShippingCostPaid || 0) * 10)) / 10 },
    reserve_shipment: group,
  };
}

async function loadParcel(strapi: Strapi, key: string | number): Promise<Parcel> {
  const group = await strapi.db.query(GROUP_UID).findOne({
    where: typeof key === "number" ? { id: key } : { groupKey: key },
    populate: groupPopulate,
  });
  if (!group) throw new AnipoWorkflowError(404, "ANIPO_PARCEL_NOT_FOUND", "بسته پیدا نشد");
  const members = await strapi.db.query(ORDER_UID).findMany({
    where: { reserve_shipment: { id: group.id } },
    populate: memberPopulate,
    orderBy: { id: "asc" },
  });
  return { group, members };
}

/** Batch page summaries from full memberships, never from filtered page members. */
export async function loadParcelSummaries(strapi: Strapi, groupIds: number[]) {
  const ids = [...new Set(groupIds)].filter((id) => id > 0);
  const summaries = new Map<number, ReturnType<typeof parcelSummary>>();
  if (!ids.length) return summaries;
  const [groups, members] = await Promise.all([
    strapi.db.query(GROUP_UID).findMany({ where: { id: { $in: ids } }, populate: groupPopulate }),
    strapi.db.query(ORDER_UID).findMany({
      where: { reserve_shipment: { id: { $in: ids } } },
      populate: memberPopulate,
      orderBy: { id: "asc" },
    }),
  ]);
  for (const group of groups)
    summaries.set(
      Number(group.id),
      parcelSummary({
        group,
        members: members.filter(
          (member: any) => Number(member.reserve_shipment?.id) === Number(group.id),
        ),
      }),
    );
  return summaries;
}

export function parcelSummary(parcel: Parcel) {
  const source = aggregateParcel(parcel);
  const group = effectiveParcelState(parcel.group, parcel.members);
  const isHeld = HELD_RESERVE_STATES.includes(group.State);
  const conflict =
    group.AnipoLastError === CONFLICT || group.AnipoLastError === "ANIPO_PARCEL_MULTIPLE_BARCODES";
  const eligible = paidMembers(parcel);
  const postal = String(source.ShippingMethodCode || "").toLowerCase() === "post";
  const issued = group.AnipoBarcodeState === "Issued" && Boolean(group.ShippingBarcode);
  const stopped = ["Stopped", "Voided"].includes(group.AnipoBarcodeState);
  const submitted = Boolean(group.AnipoSubmittedAt || group.AnipoRegistrationAttemptedAt);
  const packageData = resolveAnipoPackage(source, {});
  const recipient = buildAnipoOrderRecipient(source);
  return {
    groupKey: group.groupKey,
    orderCount: parcel.members.length,
    eligibleOrderCount: eligible.length,
    recipientName: recipient.receiverName,
    shippingMethodCode: source.ShippingMethodCode || null,
    isHeld,
    state: group.AnipoBarcodeState || null,
    barcode: group.ShippingBarcode || null,
    submittedAt: group.AnipoSubmittedAt || group.AnipoRegistrationAttemptedAt || null,
    lastCheckedAt: group.AnipoLastCheckedAt || null,
    issuedAt: group.AnipoIssuedAt || null,
    recipientSyncState: group.AnipoRecipientSyncState || null,
    weight: packageData.weight,
    boxSizeId: packageData.boxSizeId,
    registeredWeight: Number(group.ShippingWeight) > 0 ? Number(group.ShippingWeight) : null,
    registeredBoxSizeId:
      Number(group.ShippingBoxSizeId) > 0 ? Number(group.ShippingBoxSizeId) : null,
    canSubmit:
      postal &&
      !isHeld &&
      eligible.length > 0 &&
      !conflict &&
      !stopped &&
      !issued &&
      (!submitted || group.AnipoLastError === "ANIPO_REMOTE_ORDER_NOT_FOUND"),
    canCheck:
      postal &&
      !isHeld &&
      eligible.length > 0 &&
      submitted &&
      !issued &&
      !conflict &&
      !stopped &&
      group.AnipoLastError !== "ANIPO_REMOTE_ORDER_NOT_FOUND",
    canPrintLabel: issued && !conflict,
    blockedReason: conflict
      ? "این بسته چند ثبت یا بارکد آنیپو دارد؛ اطلاعات آن را بررسی کنید."
      : isHeld
        ? "در مهلت رزرو"
        : !postal
          ? "آنیپو فقط برای ارسال پستی"
          : !eligible.length
            ? "سفارشی برای ارسال باقی نمانده"
            : stopped
              ? "پیگیری ارسال این بسته متوقف شده است"
              : null,
    recipient: {
      name: recipient.receiverName,
      phone: recipient.mobile || null,
      address: recipient.fullAddress,
      postalCode: recipient.postalCode || null,
      city: recipient.cityName,
      province: recipient.provinceName,
    },
    workflow: Object.fromEntries(SHARED_FIELDS.map((field) => [field, group[field] ?? null])),
  };
}

export async function getReserveParcelSummary(strapi: Strapi, key: string | number) {
  return parcelSummary(await loadParcel(strapi, key));
}

async function save(
  strapi: Strapi,
  lease: Lease,
  data: Record<string, unknown>,
  revision?: number,
) {
  const values = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      column(key),
      value && typeof value === "object" && !(value instanceof Date)
        ? JSON.stringify(value)
        : value,
    ]),
  );
  values.updated_at = new Date();
  let query = strapi.db
    .connection("reserve_groups")
    .where({ id: lease.id, anipo_lease_token: lease.token })
    .andWhere("anipo_lease_expires_at", ">", new Date());
  if (revision !== undefined) query = query.andWhere("anipo_recipient_revision", revision);
  const rows = await query.update(values).returning("id");
  if (!rows.length)
    throw new AnipoWorkflowError(
      409,
      "ANIPO_PARCEL_CHANGED",
      "اطلاعات بسته تغییر کرده است؛ دوباره بررسی کنید",
    );
}

async function withLease<T>(
  strapi: Strapi,
  key: string | number,
  run: (parcel: Parcel, lease: Lease) => Promise<T>,
): Promise<T> {
  const initial = await loadParcel(strapi, key);
  const token = randomUUID();
  const id = Number(initial.group.id);
  const claim = await strapi.db
    .connection("reserve_groups")
    .where({ id })
    .andWhere((query) =>
      query.whereNull("anipo_lease_expires_at").orWhere("anipo_lease_expires_at", "<=", new Date()),
    )
    .update({ anipo_lease_token: token, anipo_lease_expires_at: new Date(Date.now() + LEASE_MS) })
    .returning("id");
  if (!claim.length)
    throw new AnipoWorkflowError(409, "ANIPO_PARCEL_BUSY", "درخواست این بسته در حال انجام است");
  const lease = { id, token };
  const timer = setInterval(() => {
    void strapi.db
      .connection("reserve_groups")
      .where({ id, anipo_lease_token: token })
      .update({ anipo_lease_expires_at: new Date(Date.now() + LEASE_MS) })
      .catch((error) =>
        strapi.log.error("Anipo parcel lease renewal failed", {
          groupId: id,
          error: safeError(error),
        }),
      );
  }, 60_000);
  timer.unref();
  try {
    const parcel = await loadParcel(strapi, id);
    const effective = effectiveParcelState(parcel.group, parcel.members);
    const adoption: Record<string, unknown> = {};
    for (const field of [...SHARED_FIELDS, "AnipoOrderCode", "ShippingBarcode"])
      if (effective[field] !== undefined && effective[field] !== parcel.group[field])
        adoption[field] = effective[field];
    if (Object.keys(adoption).length) await save(strapi, lease, adoption);
    parcel.group = effective;
    return await run(parcel, lease);
  } finally {
    clearInterval(timer);
    await strapi.db
      .connection("reserve_groups")
      .where({ id, anipo_lease_token: token })
      .update({ anipo_lease_token: null, anipo_lease_expires_at: null });
  }
}

function assertEligible(parcel: Parcel) {
  const view = parcelSummary(parcel);
  if (view.blockedReason)
    throw new AnipoWorkflowError(
      409,
      view.isHeld
        ? "ANIPO_RESERVE_HOLD"
        : parcel.group.AnipoLastError === CONFLICT
          ? CONFLICT
          : "ANIPO_PARCEL_INELIGIBLE",
      view.blockedReason,
    );
  if (["Stopped", "Voided"].includes(parcel.group.AnipoBarcodeState))
    throw new AnipoWorkflowError(409, "ANIPO_WORKFLOW_STOPPED", "پیگیری این بسته متوقف شده است");
}

function providerPayload(parcel: Parcel, options: SubmitOptions = {}) {
  const source = aggregateParcel(parcel);
  const recipient = buildAnipoOrderRecipient(source);
  if (!recipient.provinceName || !recipient.cityName || !recipient.mobile || !recipient.fullAddress)
    throw new AnipoWorkflowError(
      422,
      "ANIPO_MISSING_RECIPIENT",
      "نشانی یا شماره همراه گیرنده کامل نیست",
    );
  const pack = resolveAnipoPackage(
    source,
    options.weightFromItems
      ? { ...options, weight: orderWorkflow.computeProductWeight(source.order_items) }
      : options,
  );
  return {
    payload: {
      order_code: String(parcel.group.AnipoOrderCode),
      receiver_name: recipient.receiverName,
      receiver_province: recipient.provinceName,
      receiver_city: recipient.cityName,
      receiver_mobile: recipient.mobile,
      receiver_address: recipient.fullAddress,
      receiver_postal_code: recipient.postalCode,
      weight_g: pack.weight,
      box_type: pack.boxSizeId,
      package_count: 1,
      parcel_content: "پوشاک",
      order_total: computeAnipoOrderTotalIrr(source),
      order_status: mapOrderStatusToAnipo(source.Status),
    },
    pack,
  };
}

function response(parcel: Parcel, already = false): AnipoWorkflowResponse {
  return orderWorkflow.responseFromOrder(effectiveParcelState(parcel.group, parcel.members), {
    already,
  });
}

async function persistProvider(
  strapi: Strapi,
  parcel: Parcel,
  lease: Lease,
  provider: AnipoOrderResult,
  actor?: AnipoWorkflowActor,
) {
  const codes = [
    ...new Set(
      [
        parcel.group.ShippingBarcode,
        ...(parcel.group.AnipoBarcodeData?.barcodes || []),
        provider.barcode,
        ...(provider.barcodes || []),
      ]
        .filter((code): code is string => Boolean(typeof code === "string" && code.trim()))
        .map((code) => code.trim()),
    ),
  ];
  const conflict = codes.length > 1 || Number(provider.expectedCount || 1) > 1;
  const issued = provider.issued && codes.length === 1 && !conflict;
  const now = new Date();
  const data: Record<string, unknown> = {
    AnipoBarcodeState: conflict ? "NeedsAttention" : issued ? "Issued" : "Pending",
    AnipoBarcodeData: { expectedCount: 1, barcodes: codes },
    AnipoLastCheckedAt: now,
    AnipoCheckCount: Number(parcel.group.AnipoCheckCount || 0) + 1,
    AnipoLastError: conflict ? "ANIPO_PARCEL_MULTIPLE_BARCODES" : null,
    AnipoReadyToIssue: provider.readyToIssue ?? null,
    AnipoProviderStatus: provider.status || null,
    AnipoLastMessage: conflict
      ? "ثبت این بسته در آنیپو نیاز به بررسی دارد"
      : provider.message || null,
  };
  if (issued)
    Object.assign(data, { ShippingBarcode: codes[0], AnipoIssuedAt: provider.issuedAt || now });
  await save(strapi, lease, data);
  Object.assign(parcel.group, data);
  if (issued) {
    await claimGroupShippingBarcode(strapi, { groupId: lease.id, barcode: codes[0] });
    if (actor?.id)
      await logAdminBarcodeOperation(
        strapi,
        Number(parcel.group.AnipoOrderCode),
        "generate",
        actor.id,
        codes[0],
        undefined,
        actor.ip,
        actor.userAgent,
        actor.roleName,
      );
  }
  return response(parcel);
}

async function confirmRecipientSnapshot(strapi: Strapi, parcel: Parcel, lease: Lease) {
  const revision = Number(parcel.group.AnipoRecipientSnapshotRevision || 0);
  const synchronized = {
    AnipoRecipientSyncState: "Synced",
    AnipoRecipientSyncedRevision: revision,
    AnipoRecipientSyncedAt: new Date(),
    AnipoRecipientSyncLastError: null,
  };
  try {
    await save(strapi, lease, synchronized, revision);
    Object.assign(parcel.group, synchronized);
  } catch (error) {
    if (!(error instanceof AnipoWorkflowError) || error.code !== "ANIPO_PARCEL_CHANGED")
      throw error;
    // An address edit committed while the provider used the earlier snapshot.
    await save(strapi, lease, {
      AnipoRecipientSyncState: "Pending",
      AnipoRecipientSyncLastAttemptAt: null,
    });
    parcel.group.AnipoRecipientSyncState = "Pending";
  }
}

async function checkUnderLease(
  strapi: Strapi,
  parcel: Parcel,
  lease: Lease,
  actor?: AnipoWorkflowActor,
) {
  if (parcel.group.AnipoBarcodeState === "Issued") {
    if (parcel.group.ShippingBarcode)
      await claimGroupShippingBarcode(strapi, {
        groupId: lease.id,
        barcode: parcel.group.ShippingBarcode,
      });
    return response(parcel, true);
  }
  assertEligible(parcel);
  if (
    !parcel.group.AnipoOrderCode ||
    !(parcel.group.AnipoSubmittedAt || parcel.group.AnipoRegistrationAttemptedAt)
  )
    throw new AnipoWorkflowError(409, "ANIPO_NOT_SUBMITTED", "این بسته هنوز در آنیپو ثبت نشده است");
  const provider = await (strapi.service("api::shipping.anipo") as any).getOrder(
    parcel.group.AnipoOrderCode,
  );
  if (!provider?.ok || !provider.data) {
    await save(strapi, lease, {
      ...(provider?.status === 404 ? { AnipoBarcodeState: "NeedsAttention" } : {}),
      AnipoLastCheckedAt: new Date(),
      AnipoLastError:
        provider?.status === 404 ? "ANIPO_REMOTE_ORDER_NOT_FOUND" : "ANIPO_STATUS_UNAVAILABLE",
    });
    throw new AnipoWorkflowError(
      502,
      "ANIPO_STATUS_ERROR",
      "بررسی وضعیت آنیپو انجام نشد؛ دوباره تلاش کنید",
    );
  }
  if (!parcel.group.AnipoSubmittedAt) {
    await save(strapi, lease, {
      AnipoSubmittedAt: parcel.group.AnipoRegistrationAttemptedAt || new Date(),
    });
    parcel.group.AnipoSubmittedAt = parcel.group.AnipoRegistrationAttemptedAt || new Date();
    await confirmRecipientSnapshot(strapi, parcel, lease);
  }
  return persistProvider(strapi, parcel, lease, provider.data, actor);
}

export async function submitReserveParcel(
  strapi: Strapi,
  key: string | number,
  options: SubmitOptions = {},
) {
  return withLease(strapi, key, async (parcel, lease) => {
    if (parcel.group.AnipoBarcodeState === "Issued")
      return checkUnderLease(strapi, parcel, lease, options.actor);
    assertEligible(parcel);
    if (
      parcel.group.AnipoSubmittedAt &&
      parcel.group.AnipoLastError !== "ANIPO_REMOTE_ORDER_NOT_FOUND"
    )
      return response(parcel, true);
    if (
      parcel.group.AnipoRegistrationAttemptedAt &&
      !(options.forceRetry && parcel.group.AnipoLastError === "ANIPO_REMOTE_ORDER_NOT_FOUND")
    )
      return checkUnderLease(strapi, parcel, lease, options.actor);
    const code = parcel.group.AnipoOrderCode || String(paidMembers(parcel)[0].id);
    parcel.group.AnipoOrderCode = code;
    let registration: ReturnType<typeof providerPayload>;
    try {
      registration = providerPayload(parcel, options);
    } catch (error) {
      if (error instanceof AnipoWorkflowError)
        await save(strapi, lease, {
          AnipoOrderCode: code,
          AnipoBarcodeState: "NeedsAttention",
          AnipoLastError: error.code,
          AnipoLastMessage: error.message,
          AnipoLastCheckedAt: new Date(),
        });
      throw error;
    }
    const { payload, pack } = registration;
    const now = new Date();
    // Persist the reference BEFORE crossing the provider boundary. An uncertain
    // outcome is checked by that reference rather than automatically POSTed again.
    await save(strapi, lease, {
      AnipoOrderCode: code,
      AnipoBarcodeState: "Pending",
      AnipoRegistrationAttemptedAt: now,
      AnipoSubmittedAt: null,
      AnipoPollingDeadlineAt: new Date(now.getTime() + POLLING_MS),
      ShippingWeight: pack.weight,
      ShippingBoxSizeId: pack.boxSizeId,
      AnipoRecipientSnapshotRevision: Number(parcel.group.AnipoRecipientRevision || 0),
      AnipoLastError: null,
    });
    Object.assign(parcel.group, {
      AnipoBarcodeState: "Pending",
      AnipoRegistrationAttemptedAt: now,
      ShippingWeight: pack.weight,
      ShippingBoxSizeId: pack.boxSizeId,
      AnipoRecipientSnapshotRevision: Number(parcel.group.AnipoRecipientRevision || 0),
    });
    let result: any;
    try {
      result = await (strapi.service("api::shipping.anipo") as any).createOrUpdateOrder(payload);
    } catch (error) {
      await save(strapi, lease, {
        AnipoLastError: "ANIPO_REGISTER_OUTCOME_UNKNOWN",
        AnipoLastCheckedAt: new Date(),
      });
      throw new AnipoWorkflowError(
        502,
        "ANIPO_REGISTER_ERROR",
        "نتیجه ثبت بسته مشخص نیست؛ وضعیت آنیپو را بررسی کنید",
      );
    }
    if (!result?.ok) {
      const rejected = [401, 422].includes(result?.status);
      await save(strapi, lease, {
        AnipoBarcodeState: rejected ? "NeedsAttention" : "Pending",
        AnipoLastError: rejected ? "ANIPO_REGISTER_REJECTED" : "ANIPO_REGISTER_OUTCOME_UNKNOWN",
        ...(rejected ? { AnipoRegistrationAttemptedAt: null } : {}),
      });
      throw new AnipoWorkflowError(
        rejected ? 422 : 502,
        "ANIPO_REGISTER_ERROR",
        "ثبت بسته در آنیپو انجام نشد؛ اطلاعات ارسال را بررسی کنید",
      );
    }
    await save(strapi, lease, { AnipoSubmittedAt: now });
    parcel.group.AnipoSubmittedAt = now;
    await confirmRecipientSnapshot(strapi, parcel, lease);
    return persistProvider(
      strapi,
      parcel,
      lease,
      parseAnipoOrderResult(result.data) || { issued: false },
      options.actor,
    );
  });
}

export async function refreshReserveParcel(
  strapi: Strapi,
  key: string | number,
  actor?: AnipoWorkflowActor,
) {
  return withLease(strapi, key, (parcel, lease) => checkUnderLease(strapi, parcel, lease, actor));
}

/** Address changes and retries share the same provider reference and lease. */
export async function syncReserveParcelRecipient(strapi: Strapi, key: string | number) {
  return withLease(strapi, key, async (parcel, lease) => {
    assertEligible(parcel);
    if (!parcel.group.AnipoOrderCode || !parcel.group.AnipoSubmittedAt)
      return { status: "not_required" };
    const revision = Number(parcel.group.AnipoRecipientRevision || 0);
    if (
      parcel.group.AnipoRecipientSyncState === "Synced" &&
      Number(parcel.group.AnipoRecipientSyncedRevision || 0) >= revision
    )
      return { status: "already_synced" };
    const { payload } = providerPayload(parcel);
    const result = await (strapi.service("api::shipping.anipo") as any).createOrUpdateOrder(
      payload,
    );
    if (!result?.ok) {
      await save(
        strapi,
        lease,
        {
          AnipoRecipientSyncState: "NeedsAttention",
          AnipoRecipientSyncLastAttemptAt: new Date(),
          AnipoRecipientSyncAttempts: Number(parcel.group.AnipoRecipientSyncAttempts || 0) + 1,
          AnipoRecipientSyncLastError: "همگام‌سازی نشانی انجام نشد",
        },
        revision,
      );
      throw new AnipoWorkflowError(
        502,
        "ANIPO_RECIPIENT_SYNC_FAILED",
        "همگام‌سازی نشانی انجام نشد",
      );
    }
    await save(
      strapi,
      lease,
      {
        AnipoRecipientSyncedRevision: revision,
        AnipoRecipientSnapshotRevision: revision,
        AnipoRecipientSyncState: "Synced",
        AnipoRecipientSyncLastAttemptAt: new Date(),
        AnipoRecipientSyncedAt: new Date(),
        AnipoRecipientSyncLastError: null,
        AnipoRecipientSyncAttempts: 0,
      },
      revision,
    );
    return { status: "synced" };
  });
}

/** A financial member cancellation does not cancel its surviving shared parcel. */
export async function reconcileReserveParcelCancellation(strapi: Strapi, key: string | number) {
  // Record intent even when another provider operation currently owns the lease.
  // The scheduler can then recover both a busy request and provider downtime.
  const pending = await loadParcel(strapi, key);
  await strapi.db
    .query(GROUP_UID)
    .update({ where: { id: pending.group.id }, data: { AnipoCancellationPending: true } });
  return withLease(strapi, key, async (parcel, lease) => {
    if ([CONFLICT, "ANIPO_PARCEL_MULTIPLE_BARCODES"].includes(parcel.group.AnipoLastError))
      return { status: "needs_review" };
    if (paidMembers(parcel).length) {
      if (
        (parcel.group.AnipoSubmittedAt || parcel.group.AnipoRegistrationAttemptedAt) &&
        !["Stopped", "Voided"].includes(parcel.group.AnipoBarcodeState)
      )
        await save(strapi, lease, {
          AnipoRecipientRevision: Number(parcel.group.AnipoRecipientRevision || 0) + 1,
          AnipoRecipientSyncState: "Pending",
          AnipoRecipientSyncLastAttemptAt: null,
        });
      await save(strapi, lease, { AnipoCancellationPending: false });
      return { status: "retained" };
    }
    if (
      parcel.group.AnipoBarcodeState === "Voided" ||
      !parcel.group.AnipoOrderCode ||
      !(parcel.group.AnipoSubmittedAt || parcel.group.AnipoRegistrationAttemptedAt)
    ) {
      await save(strapi, lease, { AnipoCancellationPending: false });
      return {
        status: parcel.group.AnipoBarcodeState === "Voided" ? "already_cancelled" : "not_required",
      };
    }
    const result = await (strapi.service("api::shipping.anipo") as any).updateOrderStatus(
      parcel.group.AnipoOrderCode,
      mapOrderStatusToAnipo("Cancelled"),
    );
    if (!result?.ok) {
      await save(strapi, lease, { AnipoLastError: "ANIPO_PARCEL_CANCEL_PENDING" });
      throw new AnipoWorkflowError(
        502,
        "ANIPO_CANCEL_FAILED",
        "لغو مرسوله در آنیپو نیاز به بررسی دارد",
      );
    }
    await save(strapi, lease, {
      AnipoBarcodeState: "Voided",
      ShippingBarcode: null,
      AnipoRecipientSyncState: null,
      AnipoCancellationPending: false,
      AnipoBarcodeData: { expectedCount: 1, barcodes: [] },
      AnipoLastError: null,
      AnipoLastCheckedAt: new Date(),
    });
    return { status: "cancelled" };
  });
}

/** The existing maintenance scheduler also recovers group work once per parcel. */
export async function runReserveParcelReconciliation(strapi: Strapi) {
  const recipientRetryAt = new Date(Date.now() - 6 * 60 * 60_000);
  const groups = await strapi.db.query(GROUP_UID).findMany({
    where: {
      $and: [
        {
          $or: [
            { AnipoCancellationPending: true },
            { State: { $notIn: [...HELD_RESERVE_STATES] } },
          ],
        },
        {
          $or: [
            { AnipoBarcodeState: "Pending" },
            { AnipoCancellationPending: true },
            { AnipoSubmittedAt: { $notNull: true }, AnipoRecipientSyncState: "Pending" },
            {
              AnipoSubmittedAt: { $notNull: true },
              AnipoRecipientSyncState: "NeedsAttention",
              $or: [
                { AnipoRecipientSyncLastAttemptAt: { $null: true } },
                { AnipoRecipientSyncLastAttemptAt: { $lte: recipientRetryAt } },
              ],
            },
            {
              AnipoBarcodeState: { $null: true },
              orders: {
                Status: "Shipment",
                ShippingMethodCode: "post",
                AnipoBarcodeState: "Pending",
              },
            },
          ],
        },
      ],
    },
    select: ["id"],
    orderBy: [{ AnipoLastCheckedAt: "asc" }, { id: "asc" }],
    limit: 50,
  });
  let processed = 0;
  for (const group of groups) {
    try {
      const parcel = await loadParcel(strapi, Number(group.id));
      const state = effectiveParcelState(parcel.group, parcel.members);
      if (
        state.AnipoLastError === CONFLICT ||
        state.AnipoLastError === "ANIPO_PARCEL_MULTIPLE_BARCODES"
      ) {
        // Persist legacy ambiguity so it no longer occupies the legacy queue.
        await withLease(strapi, Number(group.id), async (_parcel, lease) =>
          save(strapi, lease, { AnipoCancellationPending: false }),
        );
        continue;
      }
      if (state.AnipoCancellationPending || !paidMembers(parcel).length) {
        await reconcileReserveParcelCancellation(strapi, Number(group.id));
      } else if (HELD_RESERVE_STATES.includes(state.State)) continue;
      else if (
        state.AnipoRecipientSyncState &&
        state.AnipoRecipientSyncState !== "Synced" &&
        state.AnipoSubmittedAt
      ) {
        if (
          state.AnipoRecipientSyncState === "NeedsAttention" &&
          state.AnipoRecipientSyncLastAttemptAt &&
          Date.now() - new Date(state.AnipoRecipientSyncLastAttemptAt).getTime() < 6 * 60 * 60_000
        )
          continue;
        await syncReserveParcelRecipient(strapi, Number(group.id));
      } else if (state.AnipoSubmittedAt || state.AnipoRegistrationAttemptedAt) {
        if (
          state.AnipoBarcodeState === "Pending" &&
          state.AnipoPollingDeadlineAt &&
          new Date(state.AnipoPollingDeadlineAt).getTime() <= Date.now()
        ) {
          await withLease(strapi, Number(group.id), async (_parcel, lease) =>
            save(strapi, lease, {
              AnipoBarcodeState: "NeedsAttention",
              AnipoLastError: "ANIPO_POLLING_EXPIRED",
            }),
          );
        } else if (state.AnipoBarcodeState === "Pending")
          await refreshReserveParcel(strapi, Number(group.id));
      } else if (state.AnipoBarcodeState !== "NeedsAttention") {
        await submitReserveParcel(strapi, Number(group.id), {
          weightFromItems: true,
          boxSizeId: 3,
        });
      }
      processed += 1;
    } catch (error) {
      strapi.log.error("Anipo parcel reconciliation failed", {
        groupId: group.id,
        error: safeError(error),
      });
    }
  }
  return { scanned: groups.length, processed };
}
