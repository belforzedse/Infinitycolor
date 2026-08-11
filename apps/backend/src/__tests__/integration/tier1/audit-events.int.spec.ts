import { randomUUID } from "node:crypto";
import { writeAuditEvent } from "../../../audit/writer";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

const migration = require("../../../../database/migrations/2026.08.11T15.00.00.rebuild-admin-audit-events.js");
const TABLE = "manual_admin_activities";

let strapi: any;

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

describe("canonical audit events on isolated PostgreSQL", () => {
  it("has the query indexes and append-only trigger installed", async () => {
    const indexes = await strapi.db.connection("pg_indexes")
      .where({ tablename: TABLE })
      .pluck("indexname");
    expect(indexes).toEqual(expect.arrayContaining([
      "maa_occurred_cursor_idx",
      "maa_actor_cursor_idx",
      "maa_initiator_cursor_idx",
      "maa_source_cursor_idx",
      "maa_event_key_cursor_idx",
      "maa_target_cursor_idx",
      "maa_correlation_cursor_idx",
      "maa_root_cursor_idx",
      "maa_result_cursor_idx",
    ]));

    const uniqueColumns = await strapi.db.connection.raw(`
      SELECT attr.attname AS column_name
        FROM pg_index AS idx
        JOIN pg_class AS table_class ON table_class.oid = idx.indrelid
        JOIN pg_namespace AS ns ON ns.oid = table_class.relnamespace
        JOIN pg_attribute AS attr
          ON attr.attrelid = table_class.oid
         AND attr.attnum = ANY(idx.indkey)
       WHERE ns.nspname = current_schema()
         AND table_class.relname = ?
         AND idx.indisunique = TRUE
         AND idx.indnkeyatts = 1
         AND attr.attname IN ('event_id', 'dedupe_key')
    `, [TABLE]);
    expect(uniqueColumns.rows.map((row: any) => row.column_name).sort())
      .toEqual(["dedupe_key", "event_id"]);

    const trigger = await strapi.db.connection("pg_trigger")
      .where({ tgname: "manual_admin_activities_append_only" })
      .whereNot("tgisinternal", true)
      .first("tgname");
    expect(trigger).toEqual({ tgname: "manual_admin_activities_append_only" });
  });

  it("deduplicates a retry without manufacturing a second success row", async () => {
    const marker = randomUUID();
    const input = {
      eventKey: "system.job_completed",
      initiator: { type: "system" as const, id: "integration-test", label: "Integration test" },
      actor: { type: "background_worker" as const, id: "integration-worker", label: "Integration worker" },
      origin: "queue" as const,
      target: { type: "test_operation", id: marker, label: marker },
      correlationId: marker,
      dedupeKey: `integration:audit-retry:${marker}`,
    };

    const first = await writeAuditEvent(strapi, input);
    const replay = await writeAuditEvent(strapi, input);
    expect(first.deduplicated).toBe(false);
    expect(replay).toEqual(expect.objectContaining({
      eventId: first.eventId,
      deduplicated: true,
    }));
    expect(await strapi.db.connection(TABLE).where({ dedupe_key: input.dedupeKey }).count("id as count"))
      .toEqual([{ count: "1" }]);
  });

  it("rolls the event back when its owning business transaction fails", async () => {
    const marker = randomUUID();
    await expect(strapi.db.transaction(async ({ trx }: any) => {
      await writeAuditEvent(strapi, {
        eventKey: "orders.status_changed",
        initiator: { type: "human", id: "77", label: "Transaction test admin", role: "Superadmin" },
        actor: { type: "human", id: "77", label: "Transaction test admin", role: "Superadmin" },
        origin: "admin_ui",
        target: { type: "order", id: marker },
        changes: [{ field: "status", from: "Started", to: "Shipment" }],
        dedupeKey: `integration:audit-rollback:${marker}`,
      }, { trx });
      throw new Error("INJECTED_BUSINESS_ROLLBACK");
    })).rejects.toThrow("INJECTED_BUSINESS_ROLLBACK");

    expect(await strapi.db.connection(TABLE)
      .where({ dedupe_key: `integration:audit-rollback:${marker}` })
      .first("id"))
      .toBeUndefined();
  });

  it("rejects application updates and deletes of historical events", async () => {
    const marker = randomUUID();
    const written = await writeAuditEvent(strapi, {
      eventKey: "system.job_completed",
      initiator: { type: "system", id: "integration-test" },
      actor: { type: "system", id: "integration-test" },
      origin: "maintenance",
      target: { type: "test_operation", id: marker },
      dedupeKey: `integration:audit-append-only:${marker}`,
    });

    await expect(strapi.db.connection(TABLE).where({ event_id: written.eventId }).update({
      message: "mutated",
    })).rejects.toMatchObject({ code: "55000" });
    await expect(strapi.db.connection(TABLE).where({ event_id: written.eventId }).delete())
      .rejects.toMatchObject({ code: "55000" });
  });

  it("can rerun the forward migration without changing existing history", async () => {
    const before = await strapi.db.connection(TABLE).count("id as count").first();
    await migration.up(strapi.db.connection);
    const after = await strapi.db.connection(TABLE).count("id as count").first();
    expect(after).toEqual(before);
  });
});
