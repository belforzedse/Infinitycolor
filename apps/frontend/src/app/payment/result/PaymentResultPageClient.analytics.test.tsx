import type React from "react";

/**
 * The revenue-bearing `purchase` is emitted here and nowhere else. These tests
 * drive the real page and the real analytics module against a stubbed Umami
 * API, so they assert the event that would leave the browser.
 */

const mockRouter = { push: jest.fn(), replace: jest.fn() };
const mockClearCart = jest.fn().mockResolvedValue(undefined);
const mockParams: { current: Record<string, string> } = { current: {} };
const getStatus = jest.fn();
const reconcile = jest.fn();
const getDetail = jest.fn();
const mockServices = { getStatus, reconcile, getDetail };
const clearCart = mockClearCart;

jest.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  useSearchParams: () => ({ get: (key: string) => mockParams.current[key] ?? null }),
}));
jest.mock("@/services", () => ({
  OrderService: {
    getOrderPaymentStatus: (...args: unknown[]) => mockServices.getStatus(...args),
    reconcileOrderPayment: (...args: unknown[]) => mockServices.reconcile(...args),
    getOrderDetail: (...args: unknown[]) => mockServices.getDetail(...args),
  },
}));
jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({ clearCart: mockClearCart }),
}));
jest.mock("@/components/storefront/StorefrontContainer", () => ({
  StorefrontContainer: ({ children }: { children: React.ReactNode }) => children,
}));
const track = jest.fn();
const identify = jest.fn();

const NOW = new Date("2026-09-23T10:00:00.000Z").getTime();

const status = (overrides: Record<string, unknown>) => ({
  success: true,
  orderId: 42,
  status: "Paying",
  paymentStatus: "Redirected",
  isPaid: false,
  paymentGateway: "SamanKish",
  attemptId: "attempt-1",
  canRetry: false,
  nextAction: "recheck",
  authoritative: true,
  ...overrides,
});

const paid = (overrides: Record<string, unknown> = {}) =>
  status({
    status: "Started",
    paymentStatus: "Succeeded",
    isPaid: true,
    nextAction: "view_order",
    amountIrr: 21_490_000,
    paidAmountIrr: 21_490_000,
    paidAt: new Date(NOW - 60_000).toISOString(),
    ...overrides,
  });

function eventCalls(name: string) {
  return track.mock.calls.filter(([eventName]) => eventName === name);
}

/**
 * Loads the page, React, and Testing Library from one module registry. After
 * `jest.resetModules()` this is a page reload: every in-memory guard is gone and
 * only browser storage survives.
 */
const cleanups: Array<() => void> = [];

async function loadPage() {
  const rtl = await import("@testing-library/react/pure");
  cleanups.push(rtl.cleanup);
  const { default: Page } = await import("./PaymentResultPageClient");
  return { ...rtl, Page };
}

describe("PaymentResultPageClient analytics", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockParams.current = { orderId: "42" };
    localStorage.clear();
    sessionStorage.clear();
    window.umami = { track, identify } as NonNullable<Window["umami"]>;
    process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV = "true";
    jest.spyOn(Date, "now").mockReturnValue(NOW);
    getDetail.mockRejectedValue(new Error("no session"));
  });

  afterEach(() => {
    cleanups.splice(0).forEach((cleanup) => cleanup());
    jest.useRealTimers();
    jest.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV;
    delete window.umami;
  });

  it("emits one purchase with the settled IRR revenue once Saman is verified", async () => {
    getStatus.mockResolvedValue(paid());
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(eventCalls("purchase")).toEqual([
      [
        "purchase",
        { transaction_id: "42", revenue: 21_490_000, currency: "IRR", gateway: "samankish" },
      ],
    ]);
  });

  it("does not emit a second purchase on refresh, remount, or another tab", async () => {
    getStatus.mockResolvedValue(paid());
    const firstLoad = await loadPage();
    const first = firstLoad.render(<firstLoad.Page />);
    await firstLoad.screen.findByText("پرداخت با موفقیت ثبت شد");
    first.rerender(<firstLoad.Page />);
    first.unmount();

    // A reload re-evaluates every module; only browser storage survives.
    jest.resetModules();
    const secondLoad = await loadPage();
    secondLoad.render(<secondLoad.Page />);
    await secondLoad.screen.findByText("پرداخت با موفقیت ثبت شد");

    expect(eventCalls("purchase")).toHaveLength(1);
  });

  it("never emits purchase for a gateway return the backend has not verified", async () => {
    mockParams.current = { orderId: "42", resultHint: "success", transactionId: "bank-ref" };
    getStatus.mockResolvedValue(status({ paymentGateway: "Mellat", paymentStatus: "Pending" }));
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("در حال بررسی نتیجه پرداخت");
    expect(eventCalls("purchase")).toHaveLength(0);
    expect(track).not.toHaveBeenCalledWith("purchase", expect.anything());
  });

  it("reports a Mellat user cancellation as payment_cancelled, not a failure", async () => {
    mockParams.current = { orderId: "42", resultHint: "cancelled", reason: "user-cancelled" };
    getStatus.mockResolvedValue(
      status({ paymentGateway: "Mellat", status: "Cancelled", paymentStatus: "Failed", canRetry: true }),
    );
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت تکمیل نشد");
    expect(eventCalls("payment_cancelled")).toEqual([
      ["payment_cancelled", { transaction_id: "42", gateway: "mellat" }],
    ]);
    expect(eventCalls("payment_failed")).toHaveLength(0);
    expect(eventCalls("purchase")).toHaveLength(0);
  });

  it("reports a declined payment as payment_failed with a stable category", async () => {
    getStatus.mockResolvedValue(
      status({ status: "Cancelled", paymentStatus: "Failed", canRetry: true }),
    );
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت تکمیل نشد");
    expect(eventCalls("payment_failed")).toEqual([
      [
        "payment_failed",
        { transaction_id: "42", gateway: "samankish", failure_category: "gateway_failed" },
      ],
    ]);
  });

  it("emits purchase when a pending SnappPay payment settles during polling", async () => {
    jest.useFakeTimers({ now: NOW });
    const pending = status({ paymentGateway: "SnappPay", paymentStatus: "Pending" });
    getStatus
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(paid({ paymentGateway: "SnappPay" }));
    reconcile.mockResolvedValue(pending);
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(eventCalls("purchase")).toHaveLength(0);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_500);
    });
    expect(eventCalls("purchase")).toEqual([
      [
        "purchase",
        { transaction_id: "42", revenue: 21_490_000, currency: "IRR", gateway: "snappay" },
      ],
    ]);
  });

  it("emits purchase for a Started SnappPay order while its attempt still reads Pending", async () => {
    getStatus.mockResolvedValue(
      paid({ paymentGateway: "SnappPay", paymentStatus: "Pending", isPaid: false }),
    );
    const { Page, render, screen } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت با موفقیت ثبت شد");
    expect(eventCalls("purchase")).toEqual([
      [
        "purchase",
        { transaction_id: "42", revenue: 21_490_000, currency: "IRR", gateway: "snappay" },
      ],
    ]);
  });

  it("reports payment_unresolved once when polling gives up", async () => {
    jest.useFakeTimers({ now: NOW });
    getStatus.mockResolvedValue(status({ paymentGateway: "Mellat", paymentStatus: "Pending" }));
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    // The fake clock drives Date.now, so this moves past the ~50s card budget.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });

    expect(eventCalls("payment_unresolved")).toEqual([
      ["payment_unresolved", { transaction_id: "42", gateway: "mellat" }],
    ]);
    expect(eventCalls("purchase")).toHaveLength(0);
  });

  it("emits the wallet-only purchase with the wallet gateway", async () => {
    getStatus.mockResolvedValue(paid({ paymentGateway: "Wallet", paidAmountIrr: 5_000_000 }));
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت با موفقیت ثبت شد");
    expect(eventCalls("purchase")).toEqual([
      ["purchase", { transaction_id: "42", revenue: 5_000_000, currency: "IRR", gateway: "wallet" }],
    ]);
  });

  it("does not emit purchase for an order paid long ago (a reopened history link)", async () => {
    getStatus.mockResolvedValue(paid({ paidAt: new Date(NOW - 3 * 86_400_000).toISOString() }));
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت با موفقیت ثبت شد");
    expect(eventCalls("purchase")).toHaveLength(0);
  });

  it("does not emit purchase without a backend-settled amount", async () => {
    getStatus.mockResolvedValue(paid({ paidAmountIrr: undefined, paidAt: undefined }));
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    await screen.findByText("پرداخت با موفقیت ثبت شد");
    expect(eventCalls("purchase")).toHaveLength(0);
  });

  it("still emits once and renders when browser storage throws", async () => {
    getStatus.mockResolvedValue(paid());
    jest.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    jest.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    jest.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const { Page, render, screen, act } = await loadPage();
    const view = render(<Page />);

    await screen.findByText("پرداخت با موفقیت ثبت شد");
    view.rerender(<Page />);
    expect(eventCalls("purchase")).toHaveLength(1);
  });

  it("keeps the confirmation working when analytics is blocked", async () => {
    delete window.umami;
    getStatus.mockResolvedValue(paid());
    const { Page, render, screen, act } = await loadPage();
    render(<Page />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(clearCart).toHaveBeenCalled();
  });
});
