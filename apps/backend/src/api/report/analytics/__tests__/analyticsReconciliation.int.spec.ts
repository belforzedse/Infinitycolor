/**
 * Real-Postgres integration test for the reconciliation migration
 * (`2026.08.05T15.00.00.add-analytics-reconciliation.js`) and the reconciliation
 * job's end-to-end behavior against real Strapi-written data.
 *
 * Matomo itself is not reachable from this sandbox (no MATOMO_BASE_URL/SITE_ID/
 * API_TOKEN configured), so `getMatomoEcommerceSummary` returns null by design —
 * this test proves the "matomo_unavailable" path persists correctly, which is a
 * real, exercised code path in production whenever Matomo is down or unconfigured,
 * not merely a test artifact. The comparison-with-Matomo-data branch is covered
 * by the mocked unit spec (commerceReconciliation.spec.ts).
 */
import { setupStrapi, teardownStrapi } from "../../../../__tests__/integration/strapiInstance";
import { makeFactories, type Factories } from "../../../../__tests__/integration/factories";
import { runAnalyticsReconciliationTick } from "../../../../jobs/analyticsReconciliation";

let strapi: any;
let f: Factories;

const BUCKET_DATE = "2026-05-05";
const NOW = new Date("2026-05-06T10:00:00Z"); // Tehran-local 2026-05-06 13:30 -> "yesterday" = 2026-05-05

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

beforeEach(() => {
  f = makeFactories(strapi);
});

afterEach(async () => {
  const knex = strapi.db.connection;
  await knex.raw("DELETE FROM analytics_reconciliation_daily WHERE bucket_date = ?", [BUCKET_DATE]);
  await knex.raw("DELETE FROM analytics_refresh_state WHERE source_type = ?", [
    "analytics_reconciliation",
  ]);
  await f.cleanup();
});

describe("analytics reconciliation migration + job (real Postgres)", () => {
  it("creates analytics_reconciliation_daily with the expected shape", async () => {
    const knex = strapi.db.connection;
    expect(await knex.schema.hasTable("analytics_reconciliation_daily")).toBe(true);
    for (const column of [
      "strapi_orders",
      "strapi_gross_toman",
      "strapi_net_toman",
      "matomo_orders",
      "matomo_revenue",
      "orders_delta",
      "revenue_ratio",
      "possible_currency_mismatch",
      "status",
    ]) {
      expect(await knex.schema.hasColumn("analytics_reconciliation_daily", column)).toBe(true);
    }
  });

  it("reconciles a real eligible order against Strapi and records matomo_unavailable when Matomo isn't configured", async () => {
    const knex = strapi.db.connection;

    const variation = await f.createVariation({ price: 500_000 });
    const contract = await f.createContract({ amount: 500_000, status: "Finished" });
    await f.createContractTransaction({
      contractId: contract.id,
      amount: 5_000_000, // IRR -> 500,000 Toman
      status: "Success",
      type: "Gateway",
    });
    const order = await f.createOrder({ status: "Started", contractId: contract.id });
    await f.createOrderItem({ orderId: order.id, variationId: variation.id, count: 1, perAmount: 500_000 });
    await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [`${BUCKET_DATE}T09:00:00Z`, order.id]);

    const result = await runAnalyticsReconciliationTick(strapi, {
      now: NOW,
      initialLookbackDays: 1,
      maxDaysPerTick: 5,
    });

    expect(result.status).toBe("completed");

    const rows = await knex.raw(
      "SELECT * FROM analytics_reconciliation_daily WHERE bucket_date = ?",
      [BUCKET_DATE],
    );
    const row = (rows.rows || rows[0])[0];
    expect(row).toBeDefined();
    expect(Number(row.strapi_orders)).toBe(1);
    expect(Number(row.strapi_gross_toman)).toBe(500_000);
    expect(row.matomo_orders).toBeNull();
    expect(row.matomo_revenue).toBeNull();
    expect(row.status).toBe("matomo_unavailable");
    expect(row.possible_currency_mismatch).toBe(false);
  });

  it("is idempotent: re-running the same day does not duplicate rows", async () => {
    const knex = strapi.db.connection;

    const variation = await f.createVariation({ price: 200_000 });
    const contract = await f.createContract({ amount: 200_000, status: "Finished" });
    await f.createContractTransaction({
      contractId: contract.id,
      amount: 2_000_000,
      status: "Success",
      type: "Gateway",
    });
    const order = await f.createOrder({ status: "Started", contractId: contract.id });
    await f.createOrderItem({ orderId: order.id, variationId: variation.id, count: 1, perAmount: 200_000 });
    await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [`${BUCKET_DATE}T09:00:00Z`, order.id]);

    await runAnalyticsReconciliationTick(strapi, { now: NOW, initialLookbackDays: 1, maxDaysPerTick: 5 });

    // Reset the watermark so the SAME day is reprocessed rather than skipped,
    // proving the upsert (not the watermark skip) is what prevents duplicates.
    await knex.raw(
      "UPDATE analytics_refresh_state SET watermark = ? WHERE source_type = ?",
      ["2026-05-03T00:00:00Z", "analytics_reconciliation"],
    );

    await runAnalyticsReconciliationTick(strapi, { now: NOW, initialLookbackDays: 1, maxDaysPerTick: 5 });

    const countRes = await knex.raw(
      "SELECT COUNT(*)::int AS n FROM analytics_reconciliation_daily WHERE bucket_date = ?",
      [BUCKET_DATE],
    );
    expect((countRes.rows || countRes[0])[0].n).toBe(1);
  });
});
