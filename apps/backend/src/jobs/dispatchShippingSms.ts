import type { Strapi } from "@strapi/strapi";
import { notifyScheduledShippingSms } from "../services/sms/notifications";
import { loadSmsConfig } from "../services/sms/config";

const BATCH_SIZE = 100;
const RETRY_AFTER_MS = 5 * 60 * 1000;

/** The order row is the outbox; a missed scheduler tick cannot lose its timer. */
export async function dispatchDueShippingSms(strapi: Strapi, now = new Date()) {
  if (!loadSmsConfig().enabled) return { attempted: 0, completed: 0, disabled: true };
  const connection = strapi.db.connection;
  const retryBefore = new Date(now.getTime() - RETRY_AFTER_MS);
  const rows = await connection("orders")
    .select("id")
    .where({ status: "Shipment" })
    .whereNotNull("shipping_sms_due_at")
    .where("shipping_sms_due_at", "<=", now)
    .whereNull("shipping_sms_completed_at")
    .where((query) => query.whereNull("shipping_sms_last_attempt_at")
      .orWhere("shipping_sms_last_attempt_at", "<=", retryBefore))
    .orderByRaw("shipping_sms_last_attempt_at ASC NULLS FIRST, shipping_sms_due_at ASC")
    .limit(BATCH_SIZE);

  let attempted = 0;
  let completed = 0;
  for (const { id } of rows) {
    try {
      await connection.transaction(async (trx) => {
        // Serialize overlapping scheduler jobs and cancellation against this
        // order until the provider outcome is persisted. Never lock a batch
        // while making network requests.
        const order = await trx("orders").where({ id, status: "Shipment" })
          .whereNull("shipping_sms_completed_at")
          .where("shipping_sms_due_at", "<=", now)
          .where((query) => query.whereNull("shipping_sms_last_attempt_at")
            .orWhere("shipping_sms_last_attempt_at", "<=", retryBefore))
          .forNoKeyUpdate().skipLocked().first();
        if (!order) return;
        await trx("orders").where({ id }).update({ shipping_sms_last_attempt_at: now });
        attempted++;
        const result = await notifyScheduledShippingSms(
          strapi as any, Number(id), new Date(order.shipping_sms_due_at).toISOString(),
        );
        const unknown = result.reason === "timeout" || result.reason === "request_failed" ||
          (result.status !== undefined && result.status >= 500);
        if (result.ok || result.duplicate || unknown || result.reason === "e2e_fixture") {
          // A timeout can mean accepted with the response lost. Do not resend
          // that uncertain submission automatically; the order SMS audit keeps
          // the failure/outcome available for investigation.
          await trx("orders").where({ id }).update({ shipping_sms_completed_at: now });
          completed++;
        }
        if (!result.ok && !result.duplicate) {
          strapi.log.warn(`[sms] scheduled shipping outcome order=${id} reason=${result.reason || result.status || "rejected"} automaticRetry=${!unknown && result.reason !== "e2e_fixture"}`);
        }
      });
    } catch (error) {
      strapi.log.error(`[sms] scheduled shipping dispatch failed order=${id}: ${(error as Error).message}`);
    }
  }
  return { attempted, completed };
}
