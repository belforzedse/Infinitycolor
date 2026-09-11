import { setupStrapi, teardownStrapi } from "../strapiInstance";

/**
 * Real-Postgres regression test for
 * database/migrations/2026.09.10T12.00.00.widen-woocommerce-sync-campaigns-status.js.
 *
 * `woocommerce_sync_campaigns.status` was `varchar(24)`, but its own CHECK
 * constraint allows `completed-with-exceptions` (25 chars) — every campaign
 * that finished with per-record exceptions hit Postgres 22001 the instant the
 * worker tried to persist that status, so a campaign that actually completed
 * was recorded (and reported) as `failed`. This proves the real schema, after
 * every migration has run, accepts the value — not a mock of the column.
 */
let strapi: any;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

afterEach(async () => {
  const knex = strapi.db.connection;
  await knex("woocommerce_sync_campaigns").where({ campaign_key: "int-spec:campaign-status-width" }).delete();
});

describe("woocommerce_sync_campaigns.status width (real Postgres)", () => {
  it("accepts the 25-character 'completed-with-exceptions' status", async () => {
    const knex = strapi.db.connection;

    const column = await knex("information_schema.columns")
      .select("character_maximum_length")
      .where({ table_name: "woocommerce_sync_campaigns", column_name: "status" })
      .first();
    expect(Number(column.character_maximum_length)).toBeGreaterThanOrEqual(32);

    await knex("woocommerce_sync_campaigns").insert({
      campaign_key: "int-spec:campaign-status-width",
      kind: "friday-cutover",
      status: "pending",
      scheduled_for: new Date(),
    });

    // Mirrors SyncStateStore#finishCampaign's UPDATE exactly (minus the fencing
    // token match, irrelevant to the column-width bug).
    await expect(
      knex("woocommerce_sync_campaigns")
        .where({ campaign_key: "int-spec:campaign-status-width" })
        .update({ status: "completed-with-exceptions", finished_at: new Date(), updated_at: new Date() }),
    ).resolves.not.toThrow();

    const row = await knex("woocommerce_sync_campaigns")
      .where({ campaign_key: "int-spec:campaign-status-width" })
      .first();
    expect(row.status).toBe("completed-with-exceptions");
  });
});
