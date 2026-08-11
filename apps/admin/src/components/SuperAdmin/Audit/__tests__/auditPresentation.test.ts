import type { AuditEvent } from "@/services/audit";
import {
  auditEventLabel,
  describeAuditEvent,
  entityHref,
} from "../auditPresentation";

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: 1,
    eventId: "f245984a-ab3f-4b3b-82c8-e58abf3f6dc2",
    schemaVersion: 2,
    eventKey: "orders.status_changed",
    domain: "orders",
    operation: "status_change",
    importance: "important",
    result: "success",
    mode: "human",
    occurredAt: "2026-08-11T08:00:00.000Z",
    recordedAt: "2026-08-11T08:00:01.000Z",
    initiator: { type: "human", id: "7", label: "سارا محمدی", role: "مدیر مالی" },
    actor: { type: "human", id: "7", label: "سارا محمدی", role: "مدیر مالی" },
    origin: "admin_ui",
    target: { type: "order", id: "437", label: "سفارش ۴۳۷" },
    related: null,
    changes: [{ field: "Status", label: "وضعیت", from: "Started", to: "Shipment" }],
    metadata: null,
    summaryFa: "وضعیت سفارش تغییر کرد",
    ...overrides,
  };
}

describe("auditPresentation", () => {
  it("states the administrator, target and exact before/after transition", () => {
    expect(describeAuditEvent(event())).toBe(
      "سارا محمدی وضعیت سفارش سفارش ۴۳۷ را از «Started» به «Shipment» تغییر داد.",
    );
  });

  it("makes an admin-initiated worker execution explicit", () => {
    const description = describeAuditEvent(event({
      eventKey: "imports.completed",
      mode: "automatic",
      actor: { type: "background_worker", id: "product-import", label: "Product Import Worker" },
      origin: "import",
      target: { type: "import", id: "batch-19", label: "درون‌ریزی ۱۹" },
      changes: [],
      metadata: { affectedCount: 437 },
    }));

    expect(description).toContain("پردازشگر پس‌زمینه 437 محصول را به‌روزرسانی کرد");
    expect(description).toContain("به درخواست سارا محمدی");
  });

  it("describes authentication through initiator and direct auth actor", () => {
    expect(describeAuditEvent(event({
      eventKey: "authentication.login_succeeded",
      domain: "authentication",
      operation: "login",
      mode: "automatic",
      actor: { type: "service_account", id: "infinity-auth", label: "Infinity Auth" },
      target: { type: "administrator", id: "7", label: "سارا محمدی" },
      changes: [],
    }))).toBe(
      "سارا محمدی وارد پنل مدیریت شد؛ ایجاد نشست امن را سرویس انجام داد.",
    );
  });

  it("never guesses a route for an unsupported entity type", () => {
    expect(entityHref({ type: "payment_attempt", id: "19", label: "Payment 19" })).toBeNull();
    expect(entityHref({ type: "order", id: "437", label: "Order 437" })).toBe("/orders/edit/437");
  });

  it("uses a localized event label instead of exposing a machine key", () => {
    expect(auditEventLabel("administrators.role_changed")).toBe("نقش مدیر را تغییر داد");
    expect(auditEventLabel("custom.future_event")).toBe("رویداد ثبت‌شده");
  });
});
