import type { Strapi } from "@strapi/strapi";
import { getUmamiClient, getUmamiConfig, type UmamiCollectorEvent } from "../services/umami";
import { summarizeSettledCharges } from "../../order/controllers/helpers/settledCharges";
import { FINANCIAL_DATA_FLOOR } from "../services/product-analytics";

/**
 * Server-side commerce events for Umami.
 *
 * These are diagnostics, not the revenue-bearing funnel event. Umami 3.x keys a
 * session on (website, IP, user agent, monthly salt); a distinct id links
 * sessions for profiles but never merges them. An event posted from this server
 * therefore always lands in the backend's own session and can never take part
 * in a shopper's funnel, goal, attribution, or journey. The revenue-bearing
 * `purchase` is emitted by the storefront result page once this backend reports
 * the order paid (see docs/analytics.md).
 *
 * `order_paid` (one per storefront order) and `refund` (one per Return row) give
 * Umami a settlement count to compare browser purchases against. Neither carries
 * Umami's special `revenue` key or a distinct id.
 */

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 50;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

/** Event types this module still delivers. Earlier `purchase` rows are retired in place. */
export const DELIVERABLE_EVENT_TYPES = ["order_paid", "refund"] as const;

/**
 * The new storefront took the apex on 2026-09-14 (Tehran), the same boundary as
 * every money report. Orders before that, and every WooCommerce-imported order,
 * are legacy-site sales and never become storefront analytics events.
 */
export const STOREFRONT_ANALYTICS_FLOOR = FINANCIAL_DATA_FLOOR;

type KnexLike = any;

export type AnalyticsOutboxInput = {
  websiteId?: string;
  eventType: (typeof DELIVERABLE_EVENT_TYPES)[number];
  sourceType: string;
  sourceId: string | number;
  payload: UmamiCollectorEvent;
};

export type AnalyticsOutboxRow = AnalyticsOutboxInput & {
  id: number;
  attemptCount: number;
};

function resolveKnex(value: Strapi | KnexLike): KnexLike {
  return (value as any)?.db?.connection || value;
}

function cleanSourceId(value: string | number): string | null {
  const normalized = String(value ?? "").trim();
  return normalized && normalized.length <= 160 ? normalized : null;
}

function toPositiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function toCollectorTimestamp(value: unknown): number | undefined {
  if (!value) return undefined;
  const milliseconds = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < STOREFRONT_ANALYTICS_FLOOR.getTime() ||
    milliseconds > Date.now() + 5 * 60 * 1000
  ) {
    return undefined;
  }
  return Math.floor(milliseconds / 1000);
}

/**
 * Insert an event without ever making commerce depend on the analytics provider.
 * Callers normally invoke this after their commerce transaction commits. When a
 * transaction handle is supplied, the insert participates in that transaction.
 */
export async function enqueueAnalyticsEvent(
  strapiOrKnex: Strapi | KnexLike,
  input: AnalyticsOutboxInput,
  transaction?: KnexLike,
): Promise<number | null> {
  const sourceId = cleanSourceId(input.sourceId);
  const websiteId = String(input.websiteId || getUmamiConfig().websiteId || "").trim();
  if (!sourceId || !websiteId || !input.eventType || !input.sourceType) return null;

  const knex = transaction || resolveKnex(strapiOrKnex);
  try {
    const rows = await knex("analytics_outbox")
      .insert({
        website_id: websiteId,
        event_type: String(input.eventType).slice(0, 64),
        source_type: String(input.sourceType).slice(0, 96),
        source_id: sourceId,
        payload: input.payload,
        status: "pending",
        attempt_count: 0,
        available_at: new Date(),
        created_at: new Date(),
        updated_at: new Date(),
      })
      .onConflict(["website_id", "event_type", "source_type", "source_id"])
      .ignore()
      .returning("id");
    const row = Array.isArray(rows) ? rows[0] : rows;
    return row && typeof row === "object" ? Number(row.id) || null : Number(row) || null;
  } catch (error) {
    // Outbox writes are best effort at the call boundary. The repair sweep
    // reconstructs settlement/refund events from commerce truth if this insert
    // races migration startup or transient DB availability.
    (strapiOrKnex as any)?.log?.warn?.("[analytics] outbox insert failed", {
      eventType: input.eventType,
      sourceType: input.sourceType,
      sourceId,
      error: (error as Error)?.message || String(error),
    });
    return null;
  }
}

function toCollectorEvent(params: {
  eventName: "order_paid" | "refund";
  valueIrr?: number;
  refundIrr?: number;
  gateway?: string;
  itemCount?: number;
  occurredAt?: unknown;
}): UmamiCollectorEvent {
  const gateway = String(params.gateway || "").trim().toLowerCase();
  const data: Record<string, unknown> = {
    ...(params.valueIrr ? { value_irr: params.valueIrr } : {}),
    ...(params.refundIrr ? { refund_irr: params.refundIrr } : {}),
    ...(params.itemCount ? { item_count: params.itemCount } : {}),
    ...(/^[a-z0-9_-]{1,40}$/.test(gateway) ? { gateway } : {}),
    currency: "IRR",
  };
  return {
    type: "event",
    payload: {
      website: getUmamiConfig().websiteId,
      hostname: getUmamiConfig().hostname,
      url: `/commerce/${params.eventName}`,
      name: params.eventName,
      timestamp: toCollectorTimestamp(params.occurredAt),
      data,
    },
  };
}

type LoadedOrder = {
  id: number;
  createdAt?: string | Date;
  external_source?: string | null;
  PaymentGateway?: string | null;
  order_items?: Array<{ Count?: number }>;
  contract?: { contract_transactions?: unknown[] } | null;
};

async function loadOrderForAnalytics(strapi: Strapi, orderId: number): Promise<LoadedOrder | null> {
  return strapi.entityService.findOne("api::order.order", orderId, {
    fields: ["id", "createdAt", "external_source", "PaymentGateway"],
    populate: {
      order_items: { fields: ["Count"] },
      contract: { fields: ["id"], populate: { contract_transactions: true } },
    },
  } as any) as Promise<LoadedOrder | null>;
}

/** Legacy-site sales never become storefront analytics events. */
function isStorefrontOrder(order: LoadedOrder | null): order is LoadedOrder {
  if (!order) return false;
  if (String(order.external_source || "").toLowerCase() === "woocommerce") return false;
  const created = order.createdAt ? new Date(order.createdAt).getTime() : NaN;
  return Number.isFinite(created) && created >= STOREFRONT_ANALYTICS_FLOOR.getTime();
}

/**
 * Queue the one `order_paid` diagnostic for a storefront order once it has a
 * settled charge. Keyed per order, so a wallet + gateway split is one event.
 */
export async function enqueueOrderPaid(strapi: Strapi, orderId: number): Promise<number | null> {
  try {
    const order = await loadOrderForAnalytics(strapi, orderId);
    if (!isStorefrontOrder(order)) return null;
    const settled = summarizeSettledCharges(order.contract?.contract_transactions);
    if (!settled.amountIrr) return null;
    const items = (Array.isArray(order.order_items) ? order.order_items : []).slice(0, 200);
    return enqueueAnalyticsEvent(strapi, {
      eventType: "order_paid",
      sourceType: "order",
      sourceId: Number(order.id),
      payload: toCollectorEvent({
        eventName: "order_paid",
        valueIrr: settled.amountIrr,
        gateway: order.PaymentGateway || undefined,
        itemCount: items.reduce(
          (sum, item) => sum + Math.max(1, Math.round(Number(item?.Count || 1))),
          0,
        ),
        occurredAt: settled.settledAt,
      }),
    });
  } catch (error) {
    strapi.log?.warn?.("[analytics] order_paid enqueue skipped", {
      orderId,
      error: (error as Error)?.message || String(error),
    });
    return null;
  }
}

/** Queue exactly one positive refund event for one Return transaction row. */
export async function enqueueRefundForReturn(
  strapi: Strapi,
  input: {
    orderId: number;
    contractTransactionId: number;
    amountIrr?: number;
    amountToman?: number;
    occurredAt?: string | Date | null;
  },
): Promise<number | null> {
  const refundIrr = toPositiveInteger(input.amountIrr ?? Number(input.amountToman || 0) * 10);
  if (!refundIrr || !input.contractTransactionId) return null;
  let occurredAt: unknown = input.occurredAt;
  try {
    const order = await loadOrderForAnalytics(strapi, input.orderId);
    if (!isStorefrontOrder(order)) return null;
    const transaction = (order.contract?.contract_transactions || []).find(
      (candidate: any) => Number(candidate?.id) === Number(input.contractTransactionId),
    ) as any;
    occurredAt ||=
      transaction?.SettledAt ??
      transaction?.VerifiedAt ??
      transaction?.Date ??
      transaction?.createdAt;
  } catch {
    // The return transaction remains the durable source key even if optional
    // timing enrichment cannot be loaded.
  }
  return enqueueAnalyticsEvent(strapi, {
    eventType: "refund",
    sourceType: "return_transaction",
    sourceId: input.contractTransactionId,
    payload: toCollectorEvent({
      eventName: "refund",
      refundIrr,
      occurredAt,
    }),
  });
}

async function repairCommerceEvents(strapi: Strapi, limit: number): Promise<number> {
  const knex = resolveKnex(strapi);
  const websiteId = getUmamiConfig().websiteId;
  if (!websiteId) return 0;
  let repaired = 0;
  try {
    const result = await knex.raw(
      `SELECT o.id AS order_id
         FROM orders o
         JOIN orders_contract_links ocl ON ocl.order_id = o.id
         JOIN contract_transactions_contract_links ctcl ON ctcl.contract_id = ocl.contract_id
         JOIN contract_transactions ct ON ct.id = ctcl.contract_transaction_id
         LEFT JOIN analytics_outbox ao
           ON ao.website_id = ?
          AND ao.event_type = 'order_paid'
          AND ao.source_type = 'order'
          AND ao.source_id = o.id::text
        WHERE lower(ct.status) = 'success'
          AND lower(COALESCE(ct.type, '')) <> 'return'
          AND ct.amount > 0
          AND o.external_source IS DISTINCT FROM 'woocommerce'
          AND o.created_at >= ?
          AND ao.id IS NULL
        GROUP BY o.id
        ORDER BY o.id DESC
        LIMIT ?`,
      [websiteId, STOREFRONT_ANALYTICS_FLOOR, limit],
    );
    for (const row of result?.rows || result?.[0] || []) {
      if (await enqueueOrderPaid(strapi, Number(row.order_id))) {
        repaired += 1;
      }
    }
  } catch (error) {
    strapi.log?.warn?.("[analytics] order_paid repair scan failed", {
      error: (error as Error)?.message || String(error),
    });
  }

  try {
    const result = await knex.raw(
      `SELECT ct.id AS transaction_id, o.id AS order_id, ct.amount
         FROM contract_transactions ct
         JOIN contract_transactions_contract_links ctcl
           ON ctcl.contract_transaction_id = ct.id
         JOIN orders_contract_links ocl ON ocl.contract_id = ctcl.contract_id
         JOIN orders o ON o.id = ocl.order_id
         LEFT JOIN analytics_outbox ao
           ON ao.website_id = ?
          AND ao.event_type = 'refund'
          AND ao.source_type = 'return_transaction'
          AND ao.source_id = ct.id::text
        WHERE lower(ct.status) = 'success'
          AND lower(ct.type) = 'return'
          AND ct.amount > 0
          AND o.external_source IS DISTINCT FROM 'woocommerce'
          AND o.created_at >= ?
          AND ao.id IS NULL
        ORDER BY ct.id DESC
        LIMIT ?`,
      [websiteId, STOREFRONT_ANALYTICS_FLOOR, limit],
    );
    for (const row of result?.rows || result?.[0] || []) {
      if (
        await enqueueRefundForReturn(strapi, {
          orderId: Number(row.order_id),
          contractTransactionId: Number(row.transaction_id),
          amountIrr: Number(row.amount),
        })
      ) {
        repaired += 1;
      }
    }
  } catch (error) {
    strapi.log?.warn?.("[analytics] refund repair scan failed", {
      error: (error as Error)?.message || String(error),
    });
  }
  return repaired;
}

async function claimDueRows(knex: KnexLike, limit: number): Promise<any[]> {
  return knex.transaction(async (trx: KnexLike) => {
    await trx("analytics_outbox")
      .where("status", "processing")
      .where("processing_started_at", "<", new Date(Date.now() - PROCESSING_LEASE_MS))
      .update({ status: "pending", processing_started_at: null, updated_at: new Date() });
    const rows = await trx("analytics_outbox")
      .whereIn("status", ["pending"])
      .whereIn("event_type", DELIVERABLE_EVENT_TYPES as unknown as string[])
      .where("available_at", "<=", new Date())
      .orderBy("id", "asc")
      .forUpdate()
      .skipLocked()
      .limit(limit);
    if (!rows.length) return [];
    const ids = rows.map((row: any) => row.id);
    await trx("analytics_outbox")
      .whereIn("id", ids)
      .update({ status: "processing", processing_started_at: new Date(), updated_at: new Date() });
    return rows;
  });
}

function parseStoredCollectorEvent(value: unknown): UmamiCollectorEvent {
  let candidate = Buffer.isBuffer(value) ? value.toString("utf8") : value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      throw new Error("ANALYTICS_OUTBOX_PAYLOAD_INVALID");
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("ANALYTICS_OUTBOX_PAYLOAD_INVALID");
  }
  const event = candidate as Record<string, unknown>;
  const payload = event.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("ANALYTICS_OUTBOX_PAYLOAD_INVALID");
  }
  const collectorPayload = payload as Record<string, unknown>;
  if (
    event.type !== "event" ||
    typeof collectorPayload.website !== "string" ||
    !collectorPayload.website.trim() ||
    typeof collectorPayload.name !== "string" ||
    !collectorPayload.name.trim() ||
    typeof collectorPayload.url !== "string" ||
    !collectorPayload.url.trim() ||
    (collectorPayload.data !== undefined &&
      (!collectorPayload.data ||
        typeof collectorPayload.data !== "object" ||
        Array.isArray(collectorPayload.data)))
  ) {
    throw new Error("ANALYTICS_OUTBOX_PAYLOAD_INVALID");
  }
  return candidate as UmamiCollectorEvent;
}

async function processClaimedRow(strapi: Strapi, row: any): Promise<"sent" | "retry" | "dead"> {
  const knex = resolveKnex(strapi);
  try {
    const client = getUmamiClient();
    await client.sendEvent(parseStoredCollectorEvent(row.payload));
    await knex("analytics_outbox").where({ id: row.id }).update({
      status: "sent",
      sent_at: new Date(),
      processing_started_at: null,
      updated_at: new Date(),
      last_error: null,
    });
    return "sent";
  } catch (error) {
    const attempts = Number(row.attempt_count || 0) + 1;
    const dead = attempts >= MAX_ATTEMPTS;
    const delay = Math.min(60 * 60 * 1000, 5_000 * 2 ** Math.min(attempts, 8));
    await knex("analytics_outbox")
      .where({ id: row.id })
      .update({
        status: dead ? "dead_letter" : "pending",
        attempt_count: attempts,
        available_at: new Date(Date.now() + delay),
        processing_started_at: null,
        dead_lettered_at: dead ? new Date() : null,
        last_error: String((error as Error)?.message || error).slice(0, 2_000),
        updated_at: new Date(),
      });
    if (dead) {
      strapi.log?.error?.("[analytics] outbox dead-lettered", {
        outboxId: row.id,
        eventType: row.event_type,
        sourceType: row.source_type,
        sourceId: row.source_id,
        error: String((error as Error)?.message || error).slice(0, 500),
      });
      return "dead";
    }
    return "retry";
  }
}

export async function runAnalyticsOutboxTick(
  strapi: Strapi,
  options: { limit?: number } = {},
): Promise<{ repaired: number; sent: number; retried: number; deadLettered: number }> {
  const knex = resolveKnex(strapi);
  const limit = Math.max(1, Math.min(CLAIM_LIMIT, Number(options.limit || CLAIM_LIMIT)));
  const repaired = await repairCommerceEvents(strapi, limit);
  const rows = await claimDueRows(knex, limit);
  const results = await Promise.all(rows.map((row) => processClaimedRow(strapi, row)));
  return {
    repaired,
    sent: results.filter((value) => value === "sent").length,
    retried: results.filter((value) => value === "retry").length,
    deadLettered: results.filter((value) => value === "dead").length,
  };
}

export const __private = {
  STOREFRONT_ANALYTICS_FLOOR,
  isStorefrontOrder,
  toCollectorTimestamp,
  toPositiveInteger,
  toCollectorEvent,
  parseStoredCollectorEvent,
};
