import React from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import PaymentResultPageClient from "./PaymentResultPageClient";
import { OrderService } from "@/services";

const push = jest.fn();
const replace = jest.fn();
const router = { push, replace };
const clearCart = jest.fn().mockResolvedValue(undefined);
let orderId = "42";
let legacyOrderId: string | null = null;

jest.mock("next/navigation", () => ({
  useRouter: () => router,
  useSearchParams: () => ({
    get: (key: string) => {
      if (key === "orderId") return orderId || null;
      if (key === "ResNum") return legacyOrderId;
      return null;
    },
  }),
}));
jest.mock("@/services", () => ({
  OrderService: {
    getOrderPaymentStatus: jest.fn(),
    reconcileOrderPayment: jest.fn(),
    getOrderDetail: jest.fn(),
  },
}));
jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({ clearCart }),
}));
jest.mock("@/components/storefront/StorefrontContainer", () => ({
  StorefrontContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const getStatus = OrderService.getOrderPaymentStatus as jest.Mock;
const reconcile = OrderService.reconcileOrderPayment as jest.Mock;
const getDetail = OrderService.getOrderDetail as jest.Mock;

const response = (overrides: Record<string, unknown>) => ({
  success: true,
  orderId: 42,
  status: "Paying",
  paymentStatus: "Unknown",
  isPaid: false,
  paymentGateway: "Mellat",
  canRetry: false,
  nextAction: "recheck",
  authoritative: true,
  ...overrides,
});

describe("PaymentResultPageClient", () => {
  beforeEach(() => {
    orderId = "42";
    legacyOrderId = null;
    jest.clearAllMocks();
    localStorage.clear();
    // Best-effort by default: most tests only care about the payment-status
    // section, and a rejected item fetch must not break them.
    getDetail.mockRejectedValue(new Error("no session"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("shows what the customer bought once the order detail loads", async () => {
    getStatus.mockResolvedValue(response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
    }));
    getDetail.mockResolvedValue({
      id: 42,
      Status: "Started",
      Date: "2026-09-15T09:18:42.464Z",
      Type: "Automatic",
      ShippingCost: 0,
      createdAt: "2026-09-15T09:18:42.464Z",
      updatedAt: "2026-09-15T09:18:42.464Z",
      order_items: [
        {
          id: 158117,
          Count: 1,
          PerAmount: 2149000,
          ProductTitle: "وست گلدوزی تدی N 0035",
          ProductSKU: "WC-1297070-1297075",
        },
      ],
    });

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("وست گلدوزی تدی N 0035")).toBeVisible();
    expect(
      screen.getByText(`جمع: ${(2149000).toLocaleString("fa-IR")} تومان`),
    ).toBeVisible();
    expect(getDetail).toHaveBeenCalledWith(42, { skipGlobalLoader: true });
  });

  it("keeps showing payment status when the order-detail fetch fails", async () => {
    getStatus.mockResolvedValue(response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
    }));
    getDetail.mockRejectedValue(new Error("session restore 401"));

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(screen.queryByText("اقلام سفارش")).not.toBeInTheDocument();
  });

  it("clears checkout state only after the authoritative order status is paid", async () => {
    localStorage.setItem("pendingCheckoutAttemptId", "attempt-42");
    localStorage.setItem("pendingOrderId", "42");
    getStatus.mockResolvedValue(response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
      paymentGateway: "SamanKish",
      shippingMethodCode: "local-courier",
      shippingMethodTitle: "پیک گرگان",
      nextAction: "view_order",
      transactionId: "bank-reference",
    }));

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(screen.getByText("bank-reference")).toBeVisible();
    expect(screen.getByText("در حال انجام")).toBeVisible();
    expect(screen.getByText("سامان کیش")).toBeVisible();
    expect(screen.queryByText("Started")).not.toBeInTheDocument();
    expect(screen.queryByText("SamanKish")).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "سفارش‌های گرگان حداکثر پس از ۲۴ ساعت کاری برای ارسال با پیک آماده خواهند بود.",
      ),
    ).toBeVisible();
    await waitFor(() => expect(clearCart).toHaveBeenCalledTimes(1));
    expect(getStatus).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
    expect(localStorage.getItem("pendingOrderId")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "مشاهده سفارش" }));
    expect(push).toHaveBeenCalledWith("/orders/42");
  });

  it("preserves the cart after failure and offers an explicit retry path", async () => {
    localStorage.setItem("pendingCheckoutAttemptId", "attempt-42");
    getStatus.mockResolvedValue(response({
      status: "Cancelled",
      paymentStatus: "Failed",
      canRetry: true,
      nextAction: "return_to_cart",
    }));

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت تکمیل نشد")).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "زمان آماده‌سازی و ارسال سفارش" }),
    ).not.toBeInTheDocument();
    expect(clearCart).not.toHaveBeenCalled();
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe("attempt-42");
    fireEvent.click(screen.getByRole("button", { name: "بازگشت به سبد و تلاش دوباره" }));
    expect(push).toHaveBeenCalledWith("/cart");
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
  });

  it.each([
    [
      "tipax",
      "تیپاکس",
      "سفارش شما ۲۴ الی ۴۸ ساعت کاری پس از ثبت سفارش، تحویل تیپاکس خواهد شد.",
    ],
    [
      "post",
      "پست",
      "سفارش شما ۷۲ الی ۸۶ ساعت کاری پس از ثبت سفارش، تحویل اداره پست خواهد شد.",
    ],
    [
      "local-courier",
      "پیک گرگان",
      "سفارش‌های گرگان حداکثر پس از ۲۴ ساعت کاری برای ارسال با پیک آماده خواهند بود.",
    ],
    [
      "pickup",
      "تحویل حضوری",
      "سفارش‌های گرگان حداکثر پس از ۲۴ ساعت کاری برای تحویل حضوری آماده خواهند بود.",
    ],
    [
      "legacy-method",
      "روش قدیمی",
      "زمان آماده‌سازی سفارش بر اساس روش ارسال ثبت‌شده تعیین می‌شود.",
    ],
  ])("shows the relevant preparation copy for %s", async (code, title, message) => {
    getStatus.mockResolvedValue(
      response({
        status: "Started",
        paymentStatus: "Succeeded",
        isPaid: true,
        shippingMethodCode: code,
        shippingMethodTitle: title,
      }),
    );

    render(<PaymentResultPageClient />);

    expect(await screen.findByText(message)).toBeVisible();
    expect(
      screen.getByText("زمان رسیدن سفارش پس از ارسال، بسته به روش ارسال و مقصد متفاوت است."),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "پشتیبانی" })).toHaveAttribute("href", "/contact");
  });

  it("uses Persian fallbacks for unknown customer-facing status and gateway values", async () => {
    getStatus.mockResolvedValue(
      response({
        status: "AwaitingWarehouseRobot",
        paymentStatus: "Succeeded",
        isPaid: true,
        paymentGateway: "InternalGatewayV2",
      }),
    );

    render(<PaymentResultPageClient />);

    expect(await screen.findAllByText("نامشخص")).toHaveLength(2);
    expect(screen.queryByText("AwaitingWarehouseRobot")).not.toBeInTheDocument();
    expect(screen.queryByText("InternalGatewayV2")).not.toBeInTheDocument();
  });

  it("warns against duplicate payment while ambiguous and reconciles on demand", async () => {
    getStatus.mockResolvedValue(response({ paymentStatus: "Unknown" }));
    reconcile.mockResolvedValue(response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
      nextAction: "view_order",
    }));

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("نتیجه پرداخت هنوز مشخص نیست")).toBeVisible();
    expect(screen.getByText(/فعلاً دوباره پرداخت نکنید/)).toBeVisible();
    expect(clearCart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "بررسی دوباره نتیجه" }));

    await waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(42, { skipGlobalLoader: true }),
    );
    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    await waitFor(() => expect(clearCart).toHaveBeenCalledTimes(1));
  });

  it("recovers an interrupted return using the pending order id", async () => {
    orderId = "";
    localStorage.setItem("pendingOrderId", "77");

    render(<PaymentResultPageClient />);

    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith("/payment/result?orderId=77");
    });
    expect(getStatus).not.toHaveBeenCalled();
  });

  it("reconciles a legacy callback ResNum on the canonical result surface", async () => {
    orderId = "";
    legacyOrderId = "51";
    getStatus.mockResolvedValue(
      response({ orderId: 51, status: "Started", paymentStatus: "Succeeded", isPaid: true }),
    );

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(getStatus).toHaveBeenCalledWith(51, undefined);
  });

  it("keeps the checking card mounted while quietly polling a pending SnappPay payment", async () => {
    jest.useFakeTimers();
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "SnappPay",
      status: "Paying",
      transactionId: "SNYPZQPHIA",
    });
    getStatus.mockResolvedValue(pending);
    reconcile.mockResolvedValue(pending);

    render(<PaymentResultPageClient />);

    expect(await screen.findByTestId("payment-result")).toBeVisible();
    expect(screen.getByText("در حال بررسی نتیجه پرداخت")).toBeVisible();
    expect(screen.getByText("در انتظار پرداخت")).toBeVisible();

    const statusCallsAfterPaint = getStatus.mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    await waitFor(() => expect(getStatus.mock.calls.length).toBeGreaterThan(statusCallsAfterPaint));

    expect(screen.getByTestId("payment-result")).toBeVisible();
    expect(screen.getByText("در حال بررسی نتیجه پرداخت")).toBeVisible();
    expect(screen.queryByText("در حال دریافت نتیجه پرداخت")).not.toBeInTheDocument();
    expect(getStatus).toHaveBeenCalledWith(42, { skipGlobalLoader: true });
  });

  it("caps quiet polls so a stuck Pending card/redirect status does not loop forever", async () => {
    jest.useFakeTimers();
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "Mellat",
      status: "Paying",
    });
    getStatus.mockResolvedValue(pending);

    render(<PaymentResultPageClient />);
    expect(await screen.findByTestId("payment-result")).toBeVisible();

    // 20 polls × 2.5s = 50s, plus a little headroom past the last tick.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(55_000);
    });
    await waitFor(() => {
      // initial GET + up to 20 quiet polls
      expect(getStatus.mock.calls.length).toBeLessThanOrEqual(21);
      expect(getStatus.mock.calls.length).toBeGreaterThan(1);
    });

    const callsAfterCap = getStatus.mock.calls.length;
    await act(async () => {
      await jest.advanceTimersByTimeAsync(10_000);
    });
    expect(getStatus.mock.calls.length).toBe(callsAfterCap);
  });

  it("keeps polling a pending SnappPay payment past the card-gateway cap", async () => {
    jest.useFakeTimers();
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "SnappPay",
      status: "Paying",
    });
    getStatus.mockResolvedValue(pending);
    reconcile.mockResolvedValue(pending);

    render(<PaymentResultPageClient />);
    expect(await screen.findByTestId("payment-result")).toBeVisible();
    await waitFor(() => expect(reconcile).toHaveBeenCalled());

    await act(async () => {
      await jest.advanceTimersByTimeAsync(55_000);
    });
    const callsAtOneMinute = getStatus.mock.calls.length;
    expect(callsAtOneMinute).toBeGreaterThan(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(getStatus.mock.calls.length).toBeGreaterThan(callsAtOneMinute);
    expect(reconcile.mock.calls.length).toBeGreaterThan(1);
  });

  it("stops SnappPay polling after the eight-minute settlement window", async () => {
    jest.useFakeTimers();
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "SnappPay",
      status: "Paying",
    });
    getStatus.mockResolvedValue(pending);
    reconcile.mockResolvedValue(pending);

    render(<PaymentResultPageClient />);
    expect(await screen.findByTestId("payment-result")).toBeVisible();

    await act(async () => {
      await jest.advanceTimersByTimeAsync(8 * 60_000 + 15_000);
    });
    const callsAfterCap = getStatus.mock.calls.length;
    expect(callsAfterCap).toBeGreaterThan(1);

    await act(async () => {
      await jest.advanceTimersByTimeAsync(30_000);
    });
    expect(getStatus.mock.calls.length).toBe(callsAfterCap);
  });

  it("kicks SnappPay reconcile once, then keeps reading status quietly", async () => {
    jest.useFakeTimers();
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "SnappPay",
      status: "Paying",
    });
    const paid = response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
      paymentGateway: "SnappPay",
      nextAction: "view_order",
    });
    getStatus.mockResolvedValue(pending);
    reconcile.mockResolvedValue(pending);

    render(<PaymentResultPageClient />);
    expect(await screen.findByTestId("payment-result")).toBeVisible();

    await waitFor(() =>
      expect(reconcile).toHaveBeenCalledWith(42, { skipGlobalLoader: true }),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);

    getStatus.mockResolvedValue(paid);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2500);
    });
    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
  });

  it("treats a Started SnappPay order as paid even while the attempt is still Pending", async () => {
    getStatus.mockResolvedValue(
      response({
        status: "Started",
        paymentStatus: "Pending",
        isPaid: false,
        paymentGateway: "SnappPay",
        nextAction: "recheck",
      }),
    );

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(screen.getByText("در حال انجام")).toBeVisible();
    expect(screen.getByRole("button", { name: "مشاهده سفارش" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "بررسی دوباره نتیجه" })).not.toBeInTheDocument();
    await waitFor(() => expect(clearCart).toHaveBeenCalledTimes(1));
  });

  it("ignores a 429 from auto-reconcile without clearing the checking card", async () => {
    const pending = response({
      paymentStatus: "Pending",
      paymentGateway: "SnappPay",
      status: "Paying",
      transactionId: "SNYPZQPHIA",
    });
    getStatus.mockResolvedValue(pending);
    reconcile.mockRejectedValue({ status: 429, message: "Too Many Requests" });

    render(<PaymentResultPageClient />);

    expect(await screen.findByTestId("payment-result")).toBeVisible();
    await waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
    expect(screen.getByText("در حال بررسی نتیجه پرداخت")).toBeVisible();
    expect(screen.getByText("SNYPZQPHIA")).toBeVisible();
    expect(
      screen.queryByText("نتیجه پرداخت قابل دریافت نیست. اتصال خود را بررسی و دوباره تلاش کنید."),
    ).not.toBeInTheDocument();
  });

  describe("reclaiming wallet credit held by an abandoned SnappPay checkout", () => {
    const heldSnappay = (overrides: Record<string, unknown> = {}) =>
      response({
        paymentStatus: "Redirected",
        paymentGateway: "SnappPay",
        status: "Paying",
        transactionId: "SNYPZQPHIA",
        amountIrr: 12_000_000,
        walletAmountIrr: 3_500_000,
        gatewayAmountIrr: 8_500_000,
        walletHoldStatus: "Active",
        ...overrides,
      });

    it("offers the release and sends the shopper's claim once", async () => {
      // The shopper opened SnappPay with a wallet split and came back without
      // paying. Their credit is committed to a checkout only the provider can
      // resolve, so the page has to let them say they did not pay.
      getStatus.mockResolvedValue(heldSnappay());
      reconcile.mockResolvedValue(heldSnappay({ walletReleaseRequested: true }));

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(screen.getByText(/از کیف پول شما کنار گذاشته شده/)).toBeVisible();

      const release = screen.getByRole("button", {
        name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود",
      });
      fireEvent.click(release);

      await waitFor(() =>
        expect(reconcile).toHaveBeenCalledWith(42, {
          skipGlobalLoader: true,
          abandon: true,
        }),
      );
      // The release is queued, not immediate, so the action is replaced by a
      // confirmation rather than left clickable.
      await waitFor(() =>
        expect(
          screen.queryByRole("button", {
            name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود",
          }),
        ).not.toBeInTheDocument(),
      );
      expect(screen.getByText(/درخواست لغو ثبت شد/)).toBeVisible();
    });

    it("confirms the credit is spendable again once the hold is gone", async () => {
      getStatus.mockResolvedValue(heldSnappay());
      reconcile.mockResolvedValue(
        heldSnappay({
          paymentStatus: "Cancelled",
          status: "Cancelled",
          walletHoldStatus: "Released",
          walletReleaseRequested: true,
          canRetry: true,
        }),
      );

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود" }),
      );

      expect(await screen.findByText(/اعتبار کیف پول شما آزاد شد/)).toBeVisible();
    });

    it("never offers to unwind a checkout whose credit is already spent", async () => {
      // Captured means the payment landed and the wallet leg was debited. There
      // is nothing held to give back, and the order is real.
      getStatus.mockResolvedValue(
        heldSnappay({
          paymentStatus: "Succeeded",
          status: "Started",
          isPaid: true,
          walletHoldStatus: "Captured",
        }),
      );

      render(<PaymentResultPageClient />);

      expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
      expect(
        screen.queryByRole("button", {
          name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود",
        }),
      ).not.toBeInTheDocument();
    });

    it("never offers it for a checkout that holds no wallet credit", async () => {
      getStatus.mockResolvedValue(
        response({
          paymentStatus: "Redirected",
          paymentGateway: "SnappPay",
          status: "Paying",
          walletHoldStatus: "None",
        }),
      );

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(
        screen.queryByRole("button", {
          name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود",
        }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(/از کیف پول شما کنار گذاشته شده/)).not.toBeInTheDocument();
    });

    it("does not promise a release the server refused to record", async () => {
      // The shopper's own OK return reached the backend first, so the claim was
      // dropped and no cancellation is coming. Telling them their credit is
      // being released would be a lie, and the payment is still settling.
      getStatus.mockResolvedValue(heldSnappay());
      reconcile.mockResolvedValue(heldSnappay({ walletReleaseRequested: false }));

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "پرداخت نکردم؛ اعتبار کیف پولم آزاد شود" }),
      );

      expect(await screen.findByText(/این سفارش لغو نشد/)).toBeVisible();
      expect(screen.queryByText(/درخواست لغو ثبت شد/)).not.toBeInTheDocument();
      expect(screen.queryByText(/اعتبار کیف پول شما آزاد شد/)).not.toBeInTheDocument();
    });

    it("keeps the claim off the quiet polls", async () => {
      // The page reconciles on a timer. Those must stay plain status reads —
      // only the shopper pressing the button is a statement about what they did.
      getStatus.mockResolvedValue(heldSnappay());
      reconcile.mockResolvedValue(heldSnappay());

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      await waitFor(() => expect(reconcile).toHaveBeenCalled());
      for (const call of reconcile.mock.calls) {
        expect(call[1]?.abandon).toBeUndefined();
      }
    });
  });

  describe("unresolved SnappPay credit, no wallet leg", () => {
    const strandedSnappay = (overrides: Record<string, unknown> = {}) =>
      response({
        paymentStatus: "Unknown",
        paymentGateway: "SnappPay",
        status: "Paying",
        ...overrides,
      });

    it("says the credit is reserved rather than charged", async () => {
      getStatus.mockResolvedValue(strandedSnappay());
      reconcile.mockResolvedValue(strandedSnappay());

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(screen.getByText("پرداخت شما کامل نشد")).toBeVisible();
      expect(
        screen.getByText(/اعتبار اسنپ‌پی شما فقط رزرو شده و مبلغی از شما کسر نشده است/),
      ).toBeVisible();
      expect(screen.queryByText("نتیجه پرداخت هنوز مشخص نیست")).not.toBeInTheDocument();
    });

    it("leaves a still-completing Pending payment on the checking copy", async () => {
      // Reconciliation rescues this cohort at roughly T+2m, so promising an
      // hour-long credit lock here would be alarming and usually wrong.
      const pending = strandedSnappay({ paymentStatus: "Pending" });
      getStatus.mockResolvedValue(pending);
      reconcile.mockResolvedValue(pending);

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(screen.getByText("در حال بررسی نتیجه پرداخت")).toBeVisible();
      expect(screen.queryByText("پرداخت شما کامل نشد")).not.toBeInTheDocument();
    });

    it("leaves the wallet-split case to its own copy and release action", async () => {
      const held = strandedSnappay({ walletHoldStatus: "Active", walletAmountIrr: 500_000 });
      getStatus.mockResolvedValue(held);
      reconcile.mockResolvedValue(held);

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(screen.queryByText("پرداخت شما کامل نشد")).not.toBeInTheDocument();
    });

    it("does not override a non-SnappPay gateway", async () => {
      const mellat = strandedSnappay({ paymentGateway: "Mellat" });
      getStatus.mockResolvedValue(mellat);
      reconcile.mockResolvedValue(mellat);

      render(<PaymentResultPageClient />);

      expect(await screen.findByTestId("payment-result")).toBeVisible();
      expect(screen.getByText("نتیجه پرداخت هنوز مشخص نیست")).toBeVisible();
    });
  });
});
