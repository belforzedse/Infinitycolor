import type { Strapi } from "@strapi/strapi";
import { buildAnipoOrderRecipient } from "../controllers/helpers/anipoOrder";
import {
  computeAnipoOrderTotalIrr,
  resolveAnipoPackage,
} from "./anipoBarcodeWorkflow";
import { mapOrderStatusToAnipo, type AnipoCreateOrderPayload } from "../../shipping/services/anipo";
import { enqueueAnipoRecipientSync } from "../../../queue/anipo-recipient";

const ACTIVE_ANIPO_STATES = new Set(["Pending", "Issued", "NeedsAttention"]);
const NEEDS_ATTENTION_AFTER = 5;
const NEEDS_ATTENTION_RETRY_MS = 6 * 60 * 60 * 1_000;

type AnipoService = {
  createOrUpdateOrder: (
    payload: AnipoCreateOrderPayload,
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
};

async function loadOrder(strapi: Strapi, orderId: number): Promise<any> {
  return strapi.db.query("api::order.order").findOne({
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
}

function isActiveRegistration(order: any): boolean {
  return Boolean(order?.AnipoSubmittedAt) && ACTIVE_ANIPO_STATES.has(String(order?.AnipoBarcodeState || "Pending"));
}

function buildPayload(order: any): AnipoCreateOrderPayload {
  const recipient = buildAnipoOrderRecipient(order);
  if (
    !recipient.receiverName ||
    !recipient.provinceName ||
    !recipient.cityName ||
    !recipient.mobile ||
    !recipient.fullAddress ||
    !recipient.postalCode
  ) {
    throw new Error("اطلاعات گیرنده برای همگام‌سازی آنیپو کامل نیست");
  }
  const packageData = resolveAnipoPackage(order, {});
  return {
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
  };
}

async function recordFailure(
  strapi: Strapi,
  order: any,
  expectedRevision: number,
  error: unknown,
) {
  const attempts = Number(order.AnipoRecipientSyncAttempts || 0) + 1;
  const message = (error instanceof Error ? error.message : String(error || "sync_failed")).slice(0, 1_000);
  await strapi.db.query("api::order.order").update({
    where: { id: order.id, AnipoRecipientRevision: expectedRevision },
    data: {
      AnipoRecipientSyncAttempts: attempts,
      AnipoRecipientSyncState: attempts >= NEEDS_ATTENTION_AFTER ? "NeedsAttention" : "Pending",
      AnipoRecipientSyncLastAttemptAt: new Date(),
      AnipoRecipientSyncLastError: message,
    },
  } as any);
}

/**
 * Push the latest recipient snapshot for one provider registration. Revision
 * compare-and-set prevents an older retry from being displayed as synchronized.
 * ShippingBarcode is intentionally absent from every update in this workflow.
 */
export async function processAnipoRecipientSync(
  strapi: Strapi,
  orderId: number,
  expectedRevision: number,
) {
  const order = await loadOrder(strapi, orderId);
  if (!order) return { status: "missing" as const };
  if (Number(order.AnipoRecipientRevision || 0) !== Number(expectedRevision)) {
    return { status: "stale" as const };
  }
  if (
    order.AnipoRecipientSyncState === "Synced" &&
    Number(order.AnipoRecipientSyncedRevision || 0) >= Number(expectedRevision)
  ) {
    return { status: "already_synced" as const };
  }
  if (!isActiveRegistration(order)) {
    return { status: "not_required" as const };
  }

  // Claim this exact revision/attempt timestamp before making the provider call.
  // Concurrent duplicate jobs may exist after a queue retry or reconciliation;
  // only one is allowed to cross the external side-effect boundary.
  const claimedAt = new Date();
  const claim = await strapi.db.query("api::order.order").update({
    where: {
      id: orderId,
      AnipoRecipientRevision: expectedRevision,
      AnipoRecipientSyncState: { $in: ["Pending", "NeedsAttention"] },
      ...(order.AnipoRecipientSyncLastAttemptAt
        ? { AnipoRecipientSyncLastAttemptAt: order.AnipoRecipientSyncLastAttemptAt }
        : { AnipoRecipientSyncLastAttemptAt: { $null: true } }),
    },
    data: { AnipoRecipientSyncLastAttemptAt: claimedAt },
  } as any);
  if (!claim) return { status: "already_claimed" as const };

  try {
    const anipo = strapi.service("api::shipping.anipo") as AnipoService;
    const response = await anipo.createOrUpdateOrder(buildPayload(order));
    if (!response?.ok) throw new Error(response?.error || "همگام‌سازی گیرنده در آنیپو ناموفق بود");

    const syncedAt = new Date();
    const updated = await strapi.db.query("api::order.order").update({
      where: { id: orderId, AnipoRecipientRevision: expectedRevision },
      data: {
        AnipoRecipientSyncedRevision: expectedRevision,
        AnipoRecipientSyncState: "Synced",
        AnipoRecipientSyncAttempts: 0,
        AnipoRecipientSyncLastAttemptAt: syncedAt,
        AnipoRecipientSyncLastError: null,
        AnipoRecipientSyncedAt: syncedAt,
      },
    } as any);
    return { status: updated ? ("synced" as const) : ("stale" as const) };
  } catch (error) {
    await recordFailure(strapi, order, expectedRevision, error);
    throw error;
  }
}

/** Re-queue durable pending work, including low-frequency retries needing attention. */
export async function runAnipoRecipientSyncReconciliation(strapi: Strapi) {
  const now = Date.now();
  const rows = (await strapi.db.query("api::order.order").findMany({
    where: {
      AnipoSubmittedAt: { $notNull: true },
      AnipoRecipientSyncState: { $in: ["Pending", "NeedsAttention"] },
    },
    select: [
      "id",
      "AnipoRecipientRevision",
      "AnipoRecipientSyncState",
      "AnipoRecipientSyncLastAttemptAt",
    ],
    orderBy: [{ AnipoRecipientSyncLastAttemptAt: "asc" }, { id: "asc" }],
    limit: 100,
  })) as any[];

  let queued = 0;
  for (const row of rows) {
    const lastAttempt = row.AnipoRecipientSyncLastAttemptAt
      ? new Date(row.AnipoRecipientSyncLastAttemptAt).getTime()
      : 0;
    if (
      row.AnipoRecipientSyncState === "NeedsAttention" &&
      Number.isFinite(lastAttempt) &&
      now - lastAttempt < NEEDS_ATTENTION_RETRY_MS
    ) {
      continue;
    }
    await enqueueAnipoRecipientSync(Number(row.id), Number(row.AnipoRecipientRevision || 0));
    queued += 1;
  }
  return { scanned: rows.length, queued };
}

export const __private = {
  ACTIVE_ANIPO_STATES,
  NEEDS_ATTENTION_AFTER,
  NEEDS_ATTENTION_RETRY_MS,
  buildPayload,
  isActiveRegistration,
};
