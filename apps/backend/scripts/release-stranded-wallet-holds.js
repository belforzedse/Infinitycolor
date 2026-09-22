#!/usr/bin/env node
/**
 * Hands back wallet credit left held by an order that is already over.
 *
 * Bucket A of docs/analytics/wallet-holds-stuck-classifier.sql: the reservation
 * was released or the order cancelled, but the hold is still `Active` — the
 * release hub was skipped, usually by a path that predates it. Nothing else is
 * touched:
 *
 *   - a hold on a `Paying` order is a live checkout and is left to the worker;
 *   - a hold on a `Started`/`Shipment`/`Done` order is an integrity breach and
 *     is reported, never released — the money there was captured, and "release"
 *     would be the wrong reversal (a refund is `creditOrderRefund`);
 *   - a hold whose attempt has no owner link is reported, never guessed at.
 *
 * Dry by default. `--apply` performs the release through the same CAS-guarded
 * hub the application uses, so running it twice releases nothing twice.
 *
 *   node scripts/release-stranded-wallet-holds.js            # print only
 *   node scripts/release-stranded-wallet-holds.js --apply
 *   node scripts/release-stranded-wallet-holds.js --apply --order 12345
 */
const path = require("path");

const APPLY = process.argv.includes("--apply");
const ORDER_ARG = (() => {
  const index = process.argv.indexOf("--order");
  if (index === -1) return null;
  const parsed = Number(process.argv[index + 1]);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
})();
const LIMIT = (() => {
  const index = process.argv.indexOf("--limit");
  if (index === -1) return 200;
  const parsed = Number(process.argv[index + 1]);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 2000) : 200;
})();

const CANDIDATE_SQL = `
  SELECT pa.id,
         pa.attempt_id,
         pa.wallet_amount,
         pa.gateway,
         pol.order_id,
         o.status            AS order_status,
         o.reservation_status,
         pul.user_id
    FROM payment_attempts pa
    JOIN payment_attempts_order_links pol ON pol.payment_attempt_id = pa.id
    JOIN orders o ON o.id = pol.order_id
    LEFT JOIN payment_attempts_user_links pul ON pul.payment_attempt_id = pa.id
   WHERE pa.wallet_hold_status = 'Active'
     AND (o.status = 'Cancelled' OR o.reservation_status IN ('Expired', 'Released'))
     AND ($1::int IS NULL OR pol.order_id = $1::int)
   ORDER BY pa.id
   LIMIT $2::int
`;

const PAID_STATUSES = ["Started", "Shipment", "Done"];

async function main() {
  const appDir = path.resolve(__dirname, "..");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const strapiFactory = require("@strapi/strapi");
  const strapi = strapiFactory({ appDir, distDir: path.join(appDir, "dist") });
  await strapi.load();

  try {
    const { releaseWalletHoldsForOrder } = require(
      path.join(appDir, "dist", "src", "api", "local-user-wallet", "services", "wallet-holds"),
    );

    const result = await strapi.db.connection.raw(CANDIDATE_SQL, [ORDER_ARG, LIMIT]);
    const rows = result?.rows || [];

    if (rows.length === 0) {
      console.log("No stranded wallet holds found.");
      return;
    }

    const releasable = [];
    const refused = [];
    for (const row of rows) {
      if (PAID_STATUSES.includes(String(row.order_status))) {
        refused.push({ ...row, reason: "order_is_paid" });
        continue;
      }
      if (!Number(row.user_id)) {
        refused.push({ ...row, reason: "no_owner_link" });
        continue;
      }
      releasable.push(row);
    }

    console.log(`Stranded holds found: ${rows.length}`);
    console.table(
      releasable.map((row) => ({
        attempt: row.attempt_id,
        order: row.order_id,
        gateway: row.gateway,
        irr: Number(row.wallet_amount || 0),
        orderStatus: row.order_status,
        reservation: row.reservation_status,
      })),
    );
    const totalIrr = releasable.reduce((sum, row) => sum + Number(row.wallet_amount || 0), 0);
    console.log(`Releasable: ${releasable.length} holds, ${totalIrr} IRR`);

    if (refused.length > 0) {
      console.log("\nRefused — these need a human, not this script:");
      console.table(
        refused.map((row) => ({
          attempt: row.attempt_id,
          order: row.order_id,
          orderStatus: row.order_status,
          reason: row.reason,
        })),
      );
    }

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to release the holds listed above.");
      return;
    }

    const orderIds = [...new Set(releasable.map((row) => Number(row.order_id)))];
    let released = 0;
    for (const orderId of orderIds) {
      try {
        // The application's own hub: CAS-guarded, refuses a paid order, and
        // idempotent, so repeating this releases nothing twice.
        const outcome = await strapi.db.transaction(async ({ trx }) =>
          releaseWalletHoldsForOrder(
            strapi,
            { orderId, reason: "operator_stranded_hold_repair" },
            trx,
          ),
        );
        if (outcome?.outcome === "released") {
          released += 1;
          console.log(`order ${orderId}: released ${outcome.amountIrr} IRR`);
        } else {
          console.log(`order ${orderId}: skipped (${outcome?.reason || "no_change"})`);
        }
      } catch (error) {
        console.error(`order ${orderId}: FAILED — ${String(error?.message || error)}`);
      }
    }
    console.log(`\nReleased holds for ${released}/${orderIds.length} orders.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
