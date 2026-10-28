import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { deliverySearchCondition } from "../../../api/admin-order-list/lib/delivery-search";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let ids: number[] = [];
const reportPath =
  process.env.ORDER_SEARCH_PLAN_REPORT ||
  path.join(os.tmpdir(), "infinity-admin-delivery-query-plans.json");
beforeAll(async () => {
  strapi = await setupStrapi();
});
afterAll(async () => {
  if (ids.length) {
    await strapi.db.connection("order_delivery_snapshots").whereIn("order_id", ids).delete();
    await strapi.db.connection("orders").whereIn("id", ids).delete();
  }
  await teardownStrapi();
});

it("measures indexed delivery queries on 10,000 synthetic orders", async () => {
  const knex = strapi.db.connection;
  for (let batch = 0; batch < 10; batch++) {
    const orders = await knex("orders")
      .insert(Array.from({ length: 1000 }, () => ({ status: "Started", type: "Automatic" })))
      .returning("id");
    ids.push(...orders.map((row: any) => Number(row.id)));
    await knex("order_delivery_snapshots").insert(
      orders.map((row: any, index: number) => ({
        order_id: row.id,
        city_id: 1 + (index % 100),
        full_address:
          batch === 9 && index === 999
            ? "آدرس نشانۀ اختصاصی ارزیابی"
            : `خیابان آزمایشی پلاک ${batch * 1000 + index}`,
        postal_code: String(batch * 1000 + index).padStart(10, "0"),
        capture_source: "benchmark",
      })),
    );
  }
  await knex.raw("ANALYZE orders");
  await knex.raw("ANALYZE order_delivery_snapshots");
  await knex.raw("SELECT gin_clean_pending_list('idx_order_snapshot_address'::regclass)");
  const queries = {
    postal: knex("order_delivery_snapshots").whereRaw("infinity_order_postal(postal_code) = ?", [
      "0000009999",
    ]),
    address: knex("order_delivery_snapshots").whereRaw(
      "infinity_order_address(full_address) LIKE ?",
      ["%اختصاصی ارزیابی%"],
    ),
    combined: strapi.db
      .queryBuilder("api::order.order")
      .init({
        select: ["id"],
        where: deliverySearchCondition(knex, {
          postalCode: "0000009999",
          addressText: "اختصاصی ارزیابی",
          cityId: 100,
        }),
        limit: 25,
        orderBy: [{ id: "desc" }],
      })
      .getKnexQuery(),
  };
  const report: Record<string, unknown> = {
    syntheticOrders: ids.length,
    postgres: (await knex.raw("SHOW server_version")).rows[0].server_version,
    locale: (
      await knex.raw(
        "SELECT datctype, datcollate FROM pg_database WHERE datname = current_database()",
      )
    ).rows,
    trigrams: (await knex.raw("SELECT show_trgm(?) AS trigrams", ["اختصاصی ارزیابی"])).rows,
  };
  for (const [name, query] of Object.entries(queries)) {
    const sql = (query as any).toSQL();
    const result = await knex.raw(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.sql}`,
      sql.bindings,
    );
    const plan = result.rows[0]["QUERY PLAN"][0];
    report[name] = plan;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (name === "postal") expect(JSON.stringify(plan)).toContain("idx_order_snapshot_postal");
    if (name === "address") expect(JSON.stringify(plan)).toContain("idx_order_snapshot_address");
    expect(plan.Plan["Actual Rows"]).toBe(1);
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
});
