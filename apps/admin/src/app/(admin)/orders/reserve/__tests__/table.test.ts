import {
  formatRemaining,
  getReserveGroupCustomer,
  getReserveGroupStatusMeta,
} from "../table";
import type { AdminReserveGroup } from "@/services/super-admin/orders/reserveGroups";

const group = (overrides: Partial<AdminReserveGroup> = {}): AdminReserveGroup => ({
  id: 1,
  groupKey: "grp-1",
  state: "Active",
  closureReason: null,
  isHeld: true,
  customer: { id: 5, phone: "09120000000", firstName: "سارا", lastName: "احمدی" },
  rootOrderId: 41,
  orderCount: 2,
  itemCount: 4,
  groupValue: 500_000,
  shippingCostPaid: 20_000,
  shippingMethodTitle: "پست پیشتاز",
  shippingMethodCode: "post",
  shippingBarcode: null,
  destination: "تهران، تهران",
  activatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
  closedAt: null,
  remainingMs: 20 * 3_600_000,
  lastOrderAttachedAt: null,
  lastActivityAt: new Date().toISOString(),
  ...overrides,
});

describe("reserve group status meta", () => {
  it("separates an open window from one that is about to close", () => {
    expect(getReserveGroupStatusMeta(group()).label).toBe("فعال");
    expect(
      getReserveGroupStatusMeta(group({ remainingMs: 2 * 3_600_000 })).label,
    ).toBe("رو به اتمام");
  });

  it("keeps an early release distinguishable from an automatic expiry", () => {
    expect(
      getReserveGroupStatusMeta(
        group({ state: "ReadyToFulfill", closureReason: "Expired", isHeld: false }),
      ).label,
    ).toBe("آماده ارسال");
    expect(
      getReserveGroupStatusMeta(
        group({ state: "ReadyToFulfill", closureReason: "ReleasedEarly", isHeld: false }),
      ).label,
    ).toBe("آماده ارسال (آزادسازی زودهنگام)");
  });

  it("labels every terminal state rather than collapsing them", () => {
    expect(getReserveGroupStatusMeta(group({ state: "Fulfilling" })).label).toBe("در حال ارسال");
    expect(getReserveGroupStatusMeta(group({ state: "Completed" })).label).toBe("تکمیل‌شده");
    expect(getReserveGroupStatusMeta(group({ state: "Cancelled" })).label).toBe("لغو شده");
    expect(getReserveGroupStatusMeta(group({ state: "PendingActivation" })).label).toBe(
      "در انتظار پرداخت",
    );
  });
});

describe("remaining-time formatting", () => {
  it("renders Persian digits and drops the hour part under an hour", () => {
    expect(formatRemaining(5 * 3_600_000 + 20 * 60_000)).toBe("۵ ساعت و ۲۰ دقیقه");
    expect(formatRemaining(20 * 60_000)).toBe("۲۰ دقیقه");
  });

  it("shows a dash rather than a zero countdown for a closed window", () => {
    expect(formatRemaining(null)).toBe("—");
    expect(formatRemaining(0)).toBe("—");
  });
});

describe("reserve group customer label", () => {
  it("falls back to the phone, then to an honest placeholder", () => {
    expect(getReserveGroupCustomer(group()).label).toBe("سارا احمدی");
    expect(
      getReserveGroupCustomer(
        group({ customer: { id: 5, phone: "09120000000", firstName: null, lastName: null } }),
      ).label,
    ).toBe("09120000000");
    const anonymous = getReserveGroupCustomer(
      group({ customer: { id: null, phone: null, firstName: null, lastName: null } }),
    );
    expect(anonymous).toMatchObject({ label: "بدون مشتری", isPlaceholder: true });
  });
});
