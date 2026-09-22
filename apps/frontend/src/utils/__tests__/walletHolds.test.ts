import {
  formatHoldDeadline,
  heldBalanceMessage,
  heldBalanceTooltip,
  holdsAreReconciling,
  primaryHold,
  toToman,
} from "../walletHolds";
import type { WalletHold } from "@/services/wallet";

const hold = (overrides: Partial<WalletHold> = {}): WalletHold => ({
  attemptId: "attempt-1",
  paymentAttemptId: 11,
  orderId: 22,
  gateway: "snappay",
  amountIrr: 3_000_000,
  heldAt: "2026-09-20T10:00:00.000Z",
  state: "reconciling",
  nextCheckAt: null,
  boundAt: "2026-09-20T11:30:00.000Z",
  ...overrides,
});

describe("wallet hold presentation", () => {
  it("converts IRR to toman the way the rest of the storefront does", () => {
    expect(toToman(3_000_000)).toBe(300_000);
    expect(toToman(0)).toBe(0);
  });

  it("says nothing when no credit is held", () => {
    expect(heldBalanceMessage(0, [])).toBeNull();
    expect(heldBalanceTooltip(0)).toBeNull();
  });

  it("names the amount and the deadline when both are known", () => {
    const message = heldBalanceMessage(3_000_000, [hold()]);
    expect(message).toContain("رزرو شده");
    expect(message).toContain("به‌طور خودکار آزاد می‌شود");
    // The bound is the whole point: "it comes back by itself" is only
    // reassuring if the page can say by when.
    expect(message).toContain("حداکثر تا ساعت");
  });

  it("still promises an automatic release when no bound is known", () => {
    const message = heldBalanceMessage(3_000_000, [hold({ boundAt: null })]);
    expect(message).toContain("به‌طور خودکار آزاد می‌شود");
    expect(message).not.toContain("حداکثر تا ساعت");
  });

  it("never tells a shopper mid-payment that their money is gone", () => {
    const message = heldBalanceMessage(3_000_000, [hold()]) ?? "";
    for (const alarming of ["ناموفق", "از دست", "کسر شد"]) {
      expect(message).not.toContain(alarming);
    }
  });

  it("ignores an unparseable deadline instead of rendering it", () => {
    expect(formatHoldDeadline("not-a-date")).toBeNull();
    expect(formatHoldDeadline(null)).toBeNull();
    expect(formatHoldDeadline(undefined)).toBeNull();
  });

  it("picks the newest hold and detects an in-flight reconciliation", () => {
    expect(primaryHold([])).toBeNull();
    expect(primaryHold(undefined)).toBeNull();
    expect(primaryHold([hold({ attemptId: "a" }), hold({ attemptId: "b" })])?.attemptId).toBe("a");

    expect(holdsAreReconciling([hold({ state: "reconciling" })])).toBe(true);
    expect(holdsAreReconciling([hold({ state: "releasing" })])).toBe(false);
    expect(holdsAreReconciling(undefined)).toBe(false);
  });
});
