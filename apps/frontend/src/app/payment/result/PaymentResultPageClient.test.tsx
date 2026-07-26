import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  },
}));
jest.mock("@/contexts/CartContext", () => ({
  useCart: () => ({ clearCart }),
}));
jest.mock("@/components/storefront", () => ({
  StorefrontContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const getStatus = OrderService.getOrderPaymentStatus as jest.Mock;
const reconcile = OrderService.reconcileOrderPayment as jest.Mock;

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
  });

  it("clears checkout state only after the authoritative order status is paid", async () => {
    localStorage.setItem("pendingCheckoutAttemptId", "attempt-42");
    localStorage.setItem("pendingOrderId", "42");
    getStatus.mockResolvedValue(response({
      status: "Started",
      paymentStatus: "Succeeded",
      isPaid: true,
      nextAction: "view_order",
      transactionId: "bank-reference",
    }));

    render(<PaymentResultPageClient />);

    expect(await screen.findByText("پرداخت با موفقیت ثبت شد")).toBeVisible();
    expect(screen.getByText("bank-reference")).toBeVisible();
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
    expect(clearCart).not.toHaveBeenCalled();
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBe("attempt-42");
    fireEvent.click(screen.getByRole("button", { name: "بازگشت به سبد و تلاش دوباره" }));
    expect(push).toHaveBeenCalledWith("/cart");
    expect(localStorage.getItem("pendingCheckoutAttemptId")).toBeNull();
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

    await waitFor(() => expect(reconcile).toHaveBeenCalledWith(42));
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
    expect(getStatus).toHaveBeenCalledWith(51);
  });
});
