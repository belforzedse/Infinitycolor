import { createHash } from "node:crypto";
import type { Strapi } from "@strapi/strapi";
import { isValidSnappayTransactionId } from "./snappay-security";
import { normalizeSnappayProviderStatus } from "./snappay-state-machine";
import { requestSnappayReconciliation } from "./snappay-orchestrator";

const ATTEMPT_UID = "api::payment-attempt.payment-attempt" as const;
const TX_UID =
  "api::contract-transaction.contract-transaction" as const;

export async function backfillLegacySnappayAttempts(
  strapi: Strapi,
): Promise<{ created: number; skipped: number }> {
  let lastId = 0;
  let created = 0;
  let skipped = 0;

  while (true) {
    const rows: any[] = await strapi.db.query(TX_UID).findMany({
      where: {
        id: { $gt: lastId },
        external_source: { $eqi: "SnappPay" },
      },
      populate: {
        contract: {
          populate: {
            order: { populate: { user: true } },
          },
        },
      },
      orderBy: { id: "asc" },
      limit: 100,
    } as any);
    if (!rows.length) break;

    for (const transaction of rows) {
      lastId = Math.max(lastId, Number(transaction.id));
      const contract = transaction.contract;
      const order = contract?.order;
      const transactionId = String(
        transaction.external_id || contract?.external_id || "",
      ).trim();
      if (
        !order?.id ||
        !contract?.id ||
        !String(transaction.TrackId || "").trim() ||
        !isValidSnappayTransactionId(transactionId)
      ) {
        skipped += 1;
        strapi.log.error(
          "Legacy SnappPay transaction requires manual migration",
          {
            transactionRowId: transaction.id,
            orderId: order?.id,
            hasPaymentToken: Boolean(String(transaction.TrackId || "").trim()),
            hasValidTransactionId:
              isValidSnappayTransactionId(transactionId),
          },
        );
        continue;
      }

      const existing: any = await strapi.db.query(ATTEMPT_UID).findOne({
        where: {
          Gateway: "snappay",
          providerReference: transactionId,
        },
      } as any);
      if (existing) continue;

      const amountIrr = Math.max(
        1,
        Math.round(
          Number(transaction.Amount || 0) ||
            Number(contract.Amount || 0) * 10,
        ),
      );
      const discountToman = Math.round(
        Number(transaction.DiscountAmount || 0) / 10,
      );
      const shippingToman = Number(order.ShippingCost || 0);
      const totalToman = Math.round(amountIrr / 10);
      const providerStatus = normalizeSnappayProviderStatus(
        transaction.GatewayStatus,
      );
      try {
        await strapi.db.query(ATTEMPT_UID).create({
          data: {
            attemptId: `snappay-legacy-${transaction.id}`,
            quoteHash: createHash("sha256")
              .update(
                `snappay-legacy:${transaction.id}:${transactionId}`,
              )
              .digest("hex"),
            quoteSnapshot: {
              legacy: true,
              sourceTransactionId: Number(transaction.id),
              financialSummary: {
                subtotal: Math.max(
                  0,
                  totalToman + discountToman - shippingToman,
                ),
                discount: discountToman,
                shipping: shippingToman,
                total: totalToman,
              },
            },
            Status: "Unknown",
            Gateway: "snappay",
            Amount: amountIrr,
            providerReference: transactionId,
            providerStatus,
            nextAction: "reconcile_legacy",
            nextActionAt: new Date(),
            failureCode: "SNAPPAY_LEGACY_RECONCILIATION_REQUIRED",
            failureMessage:
              "Legacy transaction must be confirmed from provider status",
            providerResponse: { legacyBackfill: true },
            user: order?.user?.id ?? order?.user,
            order: order.id,
            contract: contract.id,
          },
        } as any);
      } catch (error: any) {
        if (
          error?.code === "23505" ||
          /unique|duplicate/i.test(String(error?.message || ""))
        ) {
          continue;
        }
        throw error;
      }
      created += 1;
      await requestSnappayReconciliation(
        strapi,
        Number(order.id),
        "legacy_backfill",
      );
    }

    if (rows.length < 100) break;
  }

  return { created, skipped };
}
