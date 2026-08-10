import type { Strapi } from "@strapi/strapi";
import { getUmamiClient, getUmamiConfig, type UmamiCollectorEvent } from "../services/umami";

const MAX_ATTEMPTS = 8;
const CLAIM_LIMIT = 50;
const PROCESSING_LEASE_MS = 10 * 60 * 1000;

type KnexLike = any;

export type AnalyticsOutboxInput = {
  websiteId?: string;
  eventType: "purchase" | "refund" | string;
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

function cleanCorrelation(value: unknown): string | undefined {
  const normalized = String(value ?? "").trim();
  // Match the browser identity contract. The value is used only as Umami's
  // distinct id and is never duplicated into event data.
  return /^[A-Za-z0-9_-]{1,64}$/.test(normalized) ? normalized : undefined;
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
    milliseconds < Date.UTC(2000, 0, 1) ||
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
  eventName: string;
  correlationId?: string;
  revenueIrr?: number;
  refundIrr?: number;
  quantity?: number;
  productIds?: Array<string | number>;
  variantIds?: Array<string | number>;
  categoryIds?: Array<string | number>;
  occurredAt?: unknown;
}): UmamiCollectorEvent {
  const identifiers = (values: Array<string | number> | undefined) =>
    Array.from(
      new Set(
        (values || [])
          .map((value) => String(value).trim())
          .filter((value) => /^[A-Za-z0-9_-]{1,64}$/.test(value)),
      ),
    )
      .slice(0, 50)
      .join(",");
  const productIds = identifiers(params.productIds);
  const variantIds = identifiers(params.variantIds);
  const categoryIds = identifiers(params.categoryIds);
  const data: Record<string, unknown> = {
    ...(params.revenueIrr
      ? {
          // Umami's native revenue reports require these exact keys. The
          // explicit revenue_irr field remains useful in event-data reports.
          revenue: params.revenueIrr,
          revenue_irr: params.revenueIrr,
          value_irr: params.revenueIrr,
        }
      : {}),
    ...(params.refundIrr ? { refund_irr: params.refundIrr } : {}),
    ...(params.quantity ? { quantity: params.quantity } : {}),
    ...(productIds ? { product_ids: productIds } : {}),
    ...(variantIds ? { variant_ids: variantIds } : {}),
    ...(categoryIds ? { category_ids: categoryIds } : {}),
    currency: "IRR",
  };
  return {
    type: "event",
    payload: {
      website: getUmamiConfig().websiteId,
      hostname: getUmamiConfig().hostname,
      url: `/commerce/${params.eventName}`,
      name: params.eventName,
      id: params.correlationId,
      timestamp: toCollectorTimestamp(params.occurredAt),
      data,
    },
  };
}

async function loadOrderForAnalytics(strapi: Strapi, orderId: number): Promise<any | null> {
  return strapi.entityService.findOne("api::order.order", orderId, {
    fields: ["id", "Date", "analytics_correlation_id"],
    populate: {
      order_items: {
        fields: ["Count"],
        populate: {
          product_variation: {
            fields: ["id"],
            populate: {
              product: {
                fields: ["id"],
                populate: { product_main_category: { fields: ["id"] } },
              },
            },
          },
        },
      },
      contract: { fields: ["id", "Amount"], populate: { contract_transactions: true } },
    },
  } as any);
}

function successfulCharge(order: any, settlementTransactionId?: number): any | null {
  const transactions = Array.isArray(order?.contract?.contract_transactions)
    ? order.contract.contract_transactions
    : [];
  return (
    transactions
      .filter((tx: any) => String(tx?.Status || tx?.status).toLowerCase() === "success")
      .filter((tx: any) => String(tx?.Type || tx?.type).toLowerCase() !== "return")
      .filter(
        (tx: any) => !settlementTransactionId || Number(tx?.id) === Number(settlementTransactionId),
      )
      .sort((a: any, b: any) => Number(b?.id || 0) - Number(a?.id || 0))[0] || null
  );
}

/** Queue the sole purchase event for an order after a successful settlement. */
export async function enqueuePurchaseForOrder(
  strapi: Strapi,
  orderId: number,
  settlementTransactionId?: number,
): Promise<number | null> {
  try {
    const order = await loadOrderForAnalytics(strapi, orderId);
    if (!order) return null;
    const charge = successfulCharge(order, settlementTransactionId);
    if (!charge || !Number(charge.id)) return null;
    const revenueIrr = toPositiveInteger(charge.Amount ?? charge.amount);
    if (!revenueIrr) return null;
    const correlationId = cleanCorrelation(order.analytics_correlation_id);
    const items = (Array.isArray(order.order_items) ? order.order_items : []).slice(0, 50);
    return enqueueAnalyticsEvent(strapi, {
      eventType: "purchase",
      sourceType: "settlement_transaction",
      sourceId: Number(charge.id),
      payload: toCollectorEvent({
        eventName: "purchase",
        correlationId,
        revenueIrr,
        quantity: items.reduce(
          (sum: number, item: any) => sum + Math.max(1, Math.round(Number(item?.Count || 1))),
          0,
        ),
        productIds: items.map((item: any) => item?.product_variation?.product?.id),
        variantIds: items.map((item: any) => item?.product_variation?.id),
        categoryIds: items.map(
          (item: any) => item?.product_variation?.product?.product_main_category?.id,
        ),
        occurredAt: charge.SettledAt ?? charge.VerifiedAt ?? charge.Date ?? charge.createdAt,
      }),
    });
  } catch (error) {
    strapi.log?.warn?.("[analytics] purchase enqueue skipped", {
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
    correlationId?: string | null;
    occurredAt?: string | Date | null;
  },
): Promise<number | null> {
  const refundIrr = toPositiveInteger(input.amountIrr ?? Number(input.amountToman || 0) * 10);
  if (!refundIrr || !input.contractTransactionId) return null;
  let correlationId = cleanCorrelation(input.correlationId);
  let occurredAt: unknown = input.occurredAt;
  try {
    const order = await loadOrderForAnalytics(strapi, input.orderId);
    correlationId ||= cleanCorrelation(order?.analytics_correlation_id);
    const transaction = (order?.contract?.contract_transactions || []).find(
      (candidate: any) => Number(candidate?.id) === Number(input.contractTransactionId),
    );
    occurredAt ||=
      transaction?.SettledAt ??
      transaction?.VerifiedAt ??
      transaction?.Date ??
      transaction?.createdAt;
  } catch {
    // The return transaction remains the durable source key even if optional
    // correlation/timing enrichment cannot be loaded.
  }
  return enqueueAnalyticsEvent(strapi, {
    eventType: "refund",
    sourceType: "return_transaction",
    sourceId: input.contractTransactionId,
    payload: toCollectorEvent({
      eventName: "refund",
      correlationId,
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
      `SELECT DISTINCT ON (ct.id) o.id AS order_id, ct.id AS transaction_id
         FROM contract_transactions ct
         JOIN contract_transactions_contract_links ctcl
           ON ctcl.contract_transaction_id = ct.id
         JOIN orders_contract_links ocl ON ocl.contract_id = ctcl.contract_id
         JOIN orders o ON o.id = ocl.order_id
         LEFT JOIN analytics_outbox ao
           ON ao.website_id = ?
          AND ao.event_type = 'purchase'
          AND ao.source_type = 'settlement_transaction'
          AND ao.source_id = ct.id::text
        WHERE lower(ct.status) = 'success'
          AND lower(COALESCE(ct.type, '')) <> 'return'
          AND ao.id IS NULL
        ORDER BY ct.id DESC
        LIMIT ?`,
      [websiteId, limit],
    );
    for (const row of result?.rows || result?.[0] || []) {
      if (await enqueuePurchaseForOrder(strapi, Number(row.order_id), Number(row.transaction_id))) {
        repaired += 1;
      }
    }
  } catch (error) {
    strapi.log?.warn?.("[analytics] purchase repair scan failed", {
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
          AND ao.id IS NULL
        ORDER BY ct.id DESC
        LIMIT ?`,
      [websiteId, limit],
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
  cleanCorrelation,
  toCollectorTimestamp,
  toPositiveInteger,
  toCollectorEvent,
  parseStoredCollectorEvent,
};
