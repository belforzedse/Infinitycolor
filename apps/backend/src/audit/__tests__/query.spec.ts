import { __auditQueryInternals, mapAuditRow } from "../query";

describe("audit query contracts", () => {
  it("renders historical rows honestly as legacy without fabricating attribution", () => {
    const record = mapAuditRow({
      id: 12,
      created_at: "2026-01-02T03:04:05.000Z",
      resource_type: "Order",
      resource_id: "88",
      action: "Update",
      message: "سفارش ویرایش شد",
      severity: "success",
    });

    expect(record).toMatchObject({
      eventId: "legacy-12",
      schemaVersion: 1,
      eventKey: "legacy.activity",
      mode: "automatic",
      actor: { type: "unknown" },
      initiator: { type: "unknown" },
      origin: "legacy",
      target: { type: "order", id: "88" },
      legacy: true,
    });
  });

  it("keeps role snapshots and classifies a worker execution as automatic", () => {
    const record = mapAuditRow({
      id: 21,
      event_id: "6288a159-4c9a-4b79-93c1-93ae0e360dcb",
      schema_version: 2,
      occurred_at: "2026-08-11T08:00:00.000Z",
      recorded_at: "2026-08-11T08:00:01.000Z",
      event_key: "imports.completed",
      domain: "imports",
      operation: "complete",
      importance: "important",
      result_status: "success",
      initiator_type: "human",
      initiator_id: "7",
      initiator_label: "سارا محمدی",
      initiator_role_id: "6",
      initiator_role_name: "Finance",
      actor_type: "background_worker",
      actor_id: "product-import",
      actor_label: "Product Import Worker",
      origin: "import",
      root_event_id: "6288a159-4c9a-4b79-93c1-93ae0e360dcb",
    });

    expect(record.mode).toBe("automatic");
    expect(record.initiator).toMatchObject({
      type: "human",
      id: "7",
      label: "سارا محمدی",
      role: "Finance",
      roleId: "6",
    });
    expect(record.actor).toMatchObject({
      type: "background_worker",
      id: "product-import",
    });
  });

  it("uses opaque, validated keyset cursors", () => {
    const encoded = __auditQueryInternals.encodeCursor({
      occurredAt: "2026-08-11T08:00:00.000Z",
      id: 44,
    });
    expect(encoded).not.toContain("2026-08-11");
    expect(__auditQueryInternals.decodeCursor(encoded)).toEqual({
      occurredAt: "2026-08-11T08:00:00.000Z",
      id: 44,
    });
    expect(__auditQueryInternals.decodeCursor("not-a-cursor")).toBeNull();
  });

  it("uses current profile names for human principals and administrator targets", () => {
    const record = mapAuditRow(
      {
        id: 44,
        event_id: "a4a702a2-068a-4d45-b641-a3db08b7447a",
        schema_version: 2,
        occurred_at: "2026-08-11T08:00:00.000Z",
        recorded_at: "2026-08-11T08:00:01.000Z",
        event_key: "administrators.role_changed",
        domain: "users",
        operation: "role_change",
        importance: "critical",
        result_status: "success",
        initiator_type: "human",
        initiator_id: "7",
        initiator_label: "+989121111111",
        actor_type: "human",
        actor_id: "7",
        actor_label: "+989121111111",
        origin: "admin_ui",
        target_type: "administrator",
        target_id: "9",
        target_label: "+989122222222",
      },
      new Map([
        ["7", "سارا محمدی"],
        ["9", "علی رضایی"],
      ]),
    );

    expect(record.initiator.label).toBe("سارا محمدی");
    expect(record.actor.label).toBe("سارا محمدی");
    expect(record.target?.label).toBe("علی رضایی");
  });

  it("returns safe request origin for security events executed by the auth service", () => {
    const record = mapAuditRow({
      id: 45,
      event_id: "bfaf7353-3070-4c82-bbed-9be72fced486",
      schema_version: 2,
      occurred_at: "2026-08-11T08:00:00.000Z",
      recorded_at: "2026-08-11T08:00:01.000Z",
      event_key: "authentication.login_succeeded",
      domain: "authentication",
      operation: "login",
      importance: "important",
      result_status: "success",
      actor_type: "service_account",
      actor_id: "infinity-auth",
      initiator_type: "human",
      initiator_id: "42",
      origin: "admin_ui",
      ip: "203.0.113.9",
      user_agent: "Infinity Admin Browser",
    });

    expect(record.ip).toBe("203.0.113.9");
    expect(record.userAgent).toBe("Infinity Admin Browser");
    expect(record.mode).toBe("automatic");
  });
});
