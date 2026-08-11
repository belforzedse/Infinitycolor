import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuditEvent } from "@/services/audit";
import AuditEventDrawer from "../AuditEventDrawer";

const getRelatedAuditEvents = jest.fn().mockResolvedValue({
  items: [],
  nextCursor: null,
  hasMore: false,
});

jest.mock("@/services/audit", () => ({
  getRelatedAuditEvents: (...args: unknown[]) => getRelatedAuditEvents(...args),
}));

const auditEvent: AuditEvent = {
  id: 1,
  eventId: "381576b6-ef74-4a90-b245-c40f06182350",
  schemaVersion: 2,
  eventKey: "orders.status_changed",
  domain: "orders",
  operation: "status_change",
  importance: "important",
  result: "success",
  mode: "automatic",
  occurredAt: "2026-08-11T08:00:00.000Z",
  recordedAt: "2026-08-11T08:00:01.000Z",
  initiator: { type: "human", id: "7", label: "سارا محمدی", role: "مدیر مالی" },
  actor: { type: "background_worker", id: "order-worker", label: "Order Worker" },
  origin: "queue",
  target: { type: "order", id: "437", label: "سفارش ۴۳۷" },
  related: null,
  changes: [{ field: "Status", label: "وضعیت", from: "Started", to: "Shipment" }],
  metadata: { provider: "internal" },
  summaryFa: "وضعیت سفارش تغییر کرد",
  requestId: "request-19",
  correlationId: "workflow-19",
};

describe("AuditEventDrawer", () => {
  beforeEach(() => getRelatedAuditEvents.mockClear());

  it("presents responsibility and field-level changes before technical JSON", async () => {
    render(<AuditEventDrawer event={auditEvent} open onClose={jest.fn()} />);

    expect(await screen.findByRole("dialog", { name: "جزئیات رویداد" })).toBeInTheDocument();
    expect(screen.getByText("عامل مستقیم (Actor)")).toBeInTheDocument();
    expect(screen.getByText("درخواست‌کننده اصلی (Initiator)")).toBeInTheDocument();
    expect(screen.getByText("Order Worker")).toBeInTheDocument();
    expect(screen.getByText("سارا محمدی")).toBeInTheDocument();
    expect(screen.getByText("Started")).toBeInTheDocument();
    expect(screen.getByText("Shipment")).toBeInTheDocument();
    expect(screen.getByText("جزئیات فنی و داده پاک‌سازی‌شده")).toBeInTheDocument();
    await waitFor(() => expect(getRelatedAuditEvents).toHaveBeenCalledWith(
      auditEvent.eventId,
      { limit: 20, includeChildren: true },
      expect.any(AbortSignal),
    ));
  });

  it("dismisses with Escape through the accessible dialog interaction", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(<AuditEventDrawer event={auditEvent} open onClose={onClose} />);

    await screen.findByRole("dialog", { name: "جزئیات رویداد" });
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
