import { AuditValidationError, writeAuditEvent, resolveCurrentAuditContext } from "../writer";

describe("typed audit writer", () => {
  it("uses the live request when no audit middleware context was installed", () => {
    const previous = (global as any).strapi;
    (global as any).strapi = { requestContext: { get: () => ({ state: { user: { id: 7, username: "staff" } }, path: "/products/1/editor", method: "PUT" }) } };
    try { expect(resolveCurrentAuditContext()?.initiator.id).toBe(7); }
    finally { (global as any).strapi = previous; }
  });
  const human = {
    type: "human" as const,
    id: 7,
    label: "سارا محمدی",
    role: "Finance",
    roleId: 6,
  };

  function strapiFallback(create = jest.fn().mockResolvedValue({ id: 91 })) {
    return {
      entityService: { create },
      db: {},
    } as any;
  }

  it("persists actor, initiator, origin, role snapshots, and sanitized changes", async () => {
    const strapi = strapiFallback();
    const result = await writeAuditEvent(strapi, {
      eventId: "b2783cae-bc1f-4d35-b9fb-682f60c287e0",
      eventKey: "wallets.adjusted",
      actor: human,
      initiator: human,
      origin: "admin_ui",
      target: { type: "wallet", id: 14, label: "کیف پول کاربر ۱۴" },
      changes: [{ field: "balance", from: 100_000, to: 250_000 }],
      metadata: { reason: "اصلاح مالی", token: "must-not-persist" },
    });

    expect(result).toEqual({
      id: 91,
      eventId: "b2783cae-bc1f-4d35-b9fb-682f60c287e0",
      deduplicated: false,
    });
    const payload = strapi.entityService.create.mock.calls[0][1].data;
    expect(payload).toMatchObject({
      eventKey: "wallets.adjusted",
      actorType: "human",
      actorId: "7",
      actorLabel: "سارا محمدی",
      actorRoleId: "6",
      actorRoleName: "Finance",
      initiatorType: "human",
      initiatorId: "7",
      initiatorRoleName: "Finance",
      origin: "admin_ui",
      targetType: "wallet",
      targetId: "14",
      Metadata: { reason: "اصلاح مالی", token: "[redacted]" },
    });
  });

  it("rejects ambiguous human principals and invalid event names", async () => {
    const strapi = strapiFallback();
    await expect(writeAuditEvent(strapi, {
      eventKey: "not a stable key",
      actor: human,
      initiator: human,
      origin: "admin_ui",
    })).rejects.toBeInstanceOf(AuditValidationError);

    await expect(writeAuditEvent(strapi, {
      eventKey: "orders.updated",
      actor: { type: "human" },
      initiator: human,
      origin: "admin_ui",
    })).rejects.toThrow("actor human principal requires an id");
  });

  it("propagates persistence failures instead of silently swallowing them", async () => {
    const failure = new Error("database unavailable");
    const strapi = strapiFallback(jest.fn().mockRejectedValue(failure));
    await expect(writeAuditEvent(strapi, {
      eventKey: "administrators.role_changed",
      actor: human,
      initiator: human,
      origin: "admin_ui",
      target: { type: "administrator", id: 8 },
    })).rejects.toBe(failure);
  });
});
