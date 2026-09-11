/**
 * Real-Postgres integration test for the analytics foundation: proves the
 * `2026.08.05T12.00.00.add-analytics-foundation.js` migration produces a working
 * schema, and that the daily rollup job correctly reads real Strapi-written
 * relational data (via the real link tables, not mocked SQL) and writes an
 * idempotent rollup.
 *
 * The unit specs (commerce.spec.ts, refreshState.spec.ts, analyticsDailyRollup.spec.ts)
 * cover every SQL shape and orchestration branch against mocked `knex.raw`; this
 * file is the one place that proves the query actually executes against Strapi's
 * real link-table schema end to end.
 */
import {
  setupStrapi,
  teardownStrapi,
  getStrapi,
} from "../../../../__tests__/integration/strapiInstance";
import {
  makeFactories,
  type Factories,
  TEST_PREFIX,
} from "../../../../__tests__/integration/factories";
import { runAnalyticsDailyRollupTick } from "../../../../jobs/analyticsDailyRollup";
import { ELIGIBLE_ORDER_STATUS } from "../../services/product-analytics";

const externalIdentityMigration = require("../../../../../database/migrations/2026.08.06T09.10.00.convert-external-identity-indexes-to-constraints.js");
const outboxRepairMigration = require("../../../../../database/migrations/2026.08.10T09.00.00.repair-umami-analytics-outbox.js");

let strapi: any;
let f: Factories;

const BUCKET_DATE = "2026-05-05";
const NOW = new Date("2026-05-06T10:00:00Z"); // Tehran-local 2026-05-06 13:30 -> "yesterday" = 2026-05-05
const CUSTOM_TABLES = [
  "background_job_locks",
  "analytics_refresh_state",
  "analytics_daily_sales",
  "analytics_product_daily",
  "analytics_outbox",
  "woocommerce_sync_control",
  "woocommerce_sync_cursors",
  "woocommerce_sync_leases",
  "woocommerce_sync_items",
  "woocommerce_sync_campaigns",
  "woocommerce_sync_metrics",
];

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
  await knex.raw("DELETE FROM analytics_product_daily WHERE bucket_date = ?", [BUCKET_DATE]);
  await knex.raw("DELETE FROM analytics_daily_sales WHERE bucket_date = ?", [BUCKET_DATE]);
  await knex.raw("DELETE FROM analytics_refresh_state WHERE source_type = ?", [
    "analytics_daily_rollup",
  ]);
  await f.cleanup();
});

describe("analytics foundation migration + daily rollup (real Postgres)", () => {
  it("creates the three tables with the expected shape", async () => {
    const knex = strapi.db.connection;
    for (const table of [
      "analytics_refresh_state",
      "analytics_daily_sales",
      "analytics_product_daily",
    ]) {
      const exists = await knex.schema.hasTable(table);
      expect(exists).toBe(true);
    }
    expect(await knex.schema.hasColumn("analytics_daily_sales", "currency")).toBe(true);
    expect(await knex.schema.hasColumn("analytics_daily_sales", "net_toman")).toBe(true);
    expect(await knex.schema.hasColumn("analytics_product_daily", "product_variation_id")).toBe(
      true,
    );
    expect(await knex.schema.hasColumn("analytics_outbox", "source_id")).toBe(true);
  });

  it("repairs an upgrade where schema sync removed an already-recorded outbox", async () => {
    const knex = strapi.db.connection;
    const coreStoreQuery = knex("strapi_core_store_settings")
      .where({ key: "core_persisted_tables" })
      .whereNull("environment")
      .whereNull("tag");
    const row = await coreStoreQuery.clone().select("id", "value").first();
    const persisted = JSON.parse(row.value).filter(
      (entry: string | { name?: string }) =>
        (typeof entry === "string" ? entry : entry?.name) !== "analytics_outbox",
    );
    await coreStoreQuery.clone().update({ value: JSON.stringify(persisted) });
    await knex.schema.dropTableIfExists("analytics_outbox");

    await knex.transaction((transaction: any) => outboxRepairMigration.up(transaction));
    await knex.transaction((transaction: any) => outboxRepairMigration.up(transaction));

    expect(await knex.schema.hasTable("analytics_outbox")).toBe(true);
    expect(await knex.schema.hasColumn("analytics_outbox", "source_id")).toBe(true);
    const repaired = await coreStoreQuery.clone().select("value").first();
    const outboxEntries = JSON.parse(repaired.value).filter(
      (entry: string | { name?: string }) =>
        (typeof entry === "string" ? entry : entry?.name) === "analytics_outbox",
    );
    expect(outboxEntries).toEqual(["analytics_outbox"]);
  });

  it("rolls up a real eligible order (via Strapi's real link tables) into analytics_daily_sales and analytics_product_daily", async () => {
    const knex = strapi.db.connection;

    const variation = await f.createVariation({ price: 800_000 });
    const contract = await f.createContract({ amount: 1_600_000, status: "Finished" });
    await f.createContractTransaction({
      contractId: contract.id,
      amount: 16_000_000, // IRR -> 1,600,000 Toman
      status: "Success",
      type: "Gateway",
    });
    const order = await f.createOrder({ status: ELIGIBLE_ORDER_STATUS, contractId: contract.id });
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 2,
      perAmount: 800_000,
    });

    // Pin the order date to a fixed calendar day; the factory always stamps "now".
    await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [
      `${BUCKET_DATE}T09:00:00Z`,
      order.id,
    ]);

    const result = await runAnalyticsDailyRollupTick(strapi, {
      now: NOW,
      initialLookbackDays: 3,
      maxDaysPerTick: 10,
    });

    expect(result.status).toBe("completed");

    const salesRows = await knex.raw("SELECT * FROM analytics_daily_sales WHERE bucket_date = ?", [
      BUCKET_DATE,
    ]);
    const salesRow = (salesRows.rows || salesRows[0])[0];
    expect(salesRow).toBeDefined();
    expect(Number(salesRow.gross_toman)).toBe(1_600_000);
    expect(Number(salesRow.units)).toBe(2);
    expect(Number(salesRow.eligible_orders)).toBe(1);
    expect(Number(salesRow.net_toman)).toBe(1_600_000);
    expect(salesRow.currency).toBe("Toman");

    const productRows = await knex.raw(
      "SELECT * FROM analytics_product_daily WHERE bucket_date = ? AND product_variation_id = ?",
      [BUCKET_DATE, variation.id],
    );
    const productRow = (productRows.rows || productRows[0])[0];
    expect(productRow).toBeDefined();
    expect(Number(productRow.units)).toBe(2);
    expect(Number(productRow.gross_toman)).toBe(1_600_000);

    const stateRows = await knex.raw(
      "SELECT * FROM analytics_refresh_state WHERE source_type = ?",
      ["analytics_daily_rollup"],
    );
    const stateRow = (stateRows.rows || stateRows[0])[0];
    expect(stateRow).toBeDefined();
    expect(stateRow.last_status).toBe("success");
    expect(new Date(stateRow.watermark).toISOString().slice(0, 10)).toBe(BUCKET_DATE);
  });

  it("is idempotent: re-running the same window does not duplicate rows", async () => {
    const knex = strapi.db.connection;

    const variation = await f.createVariation({ price: 350_000 });
    const contract = await f.createContract({ amount: 350_000, status: "Finished" });
    await f.createContractTransaction({
      contractId: contract.id,
      amount: 3_500_000,
      status: "Success",
      type: "Gateway",
    });
    const order = await f.createOrder({ status: ELIGIBLE_ORDER_STATUS, contractId: contract.id });
    await f.createOrderItem({
      orderId: order.id,
      variationId: variation.id,
      count: 1,
      perAmount: 350_000,
    });
    await knex.raw("UPDATE orders SET date = ? WHERE id = ?", [
      `${BUCKET_DATE}T09:00:00Z`,
      order.id,
    ]);

    await runAnalyticsDailyRollupTick(strapi, {
      now: NOW,
      initialLookbackDays: 3,
      maxDaysPerTick: 10,
    });

    // Reset the watermark so the SAME window is reprocessed rather than skipped,
    // proving the upsert itself (not the watermark skip) is what prevents duplicates.
    await knex.raw("UPDATE analytics_refresh_state SET watermark = ? WHERE source_type = ?", [
      `${BUCKET_DATE}T00:00:00Z`.replace(BUCKET_DATE, "2026-05-03"),
      "analytics_daily_rollup",
    ]);

    await runAnalyticsDailyRollupTick(strapi, {
      now: NOW,
      initialLookbackDays: 3,
      maxDaysPerTick: 10,
    });

    const countRes = await knex.raw(
      "SELECT COUNT(*)::int AS n FROM analytics_daily_sales WHERE bucket_date = ?",
      [BUCKET_DATE],
    );
    expect((countRes.rows || countRes[0])[0].n).toBe(1);

    const productCountRes = await knex.raw(
      "SELECT COUNT(*)::int AS n FROM analytics_product_daily WHERE bucket_date = ? AND product_variation_id = ?",
      [BUCKET_DATE, variation.id],
    );
    expect((productCountRes.rows || productCountRes[0])[0].n).toBe(1);
  });

  it("survives a full schema reconciliation against an existing database", async () => {
    const knex = strapi.db.connection;

    // Reproduce the staging shape produced by the original WooCommerce
    // migration: named standalone partial indexes, not table constraints.
    const externalIdentityConstraints =
      externalIdentityMigration.__private.EXTERNAL_IDENTITY_CONSTRAINTS;
    for (const [tableName, constraintName] of externalIdentityConstraints) {
      await knex.raw("ALTER TABLE ?? DROP CONSTRAINT ??", [tableName, constraintName]);
      await knex.raw(
        `CREATE UNIQUE INDEX ?? ON ?? (external_source, external_id)
          WHERE external_source IS NOT NULL AND external_id IS NOT NULL`,
        [constraintName, tableName],
      );
    }
    await knex.transaction((transaction: any) => externalIdentityMigration.up(transaction));

    await knex("strapi_database_schema").del();

    await teardownStrapi();
    strapi = await setupStrapi();
    f = makeFactories(strapi);

    const reloadedKnex = strapi.db.connection;
    for (const tableName of CUSTOM_TABLES) {
      expect(await reloadedKnex.schema.hasTable(tableName)).toBe(true);
    }

    const persistedRow = await reloadedKnex("strapi_core_store_settings")
      .select("value")
      .where({ key: "core_persisted_tables" })
      .whereNull("environment")
      .whereNull("tag")
      .first();
    expect(JSON.parse(persistedRow.value)).toEqual(expect.arrayContaining(CUSTOM_TABLES));

    const expectedIndexes = [
      "uq_products_external_source_id",
      "uq_product_variations_external_source_id",
      "uq_product_stocks_external_source_id",
      "uq_orders_external_source_id",
      "uq_contracts_external_source_id",
      "uq_order_items_external_source_id",
      "uq_users_external_source_id",
    ];
    const constraintResult = await reloadedKnex.raw(
      `SELECT constraint_name
         FROM information_schema.table_constraints
        WHERE constraint_schema = current_schema()
          AND constraint_type = 'UNIQUE'
          AND constraint_name = ANY(?)`,
      [expectedIndexes],
    );
    expect(
      constraintResult.rows.map((row: { constraint_name: string }) => row.constraint_name).sort(),
    ).toEqual(expectedIndexes.sort());
  });
});
