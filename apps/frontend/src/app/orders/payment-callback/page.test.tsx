import React from "react";
import { render, waitFor, screen } from "@testing-library/react";
import { useCart } from "@/contexts/CartContext";
import { trackFunnelStep, trackMatomoEvent } from "@/lib/analytics/matomo";

const mockPush = jest.fn();
const mockClearCart = jest.fn();
let currentSearchParams: Record<string, string | null | undefined> = {
  ResNum: "123",
  RefNum: "abc",
};

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  useSearchParams: () => ({
    get: (key: string) => currentSearchParams[key] ?? null,
  }),
}));

jest.mock("@/services", () => ({
  OrderService: {
    verifyPayment: jest.fn(),
    getOrderPaymentStatus: jest.fn(),
  },
}));

jest.mock("jotai", () => ({
  atom: () => ({}),
  useAtom: () => [null, jest.fn()],
}));

jest.mock("@/contexts/CartContext", () => ({
  useCart: jest.fn(),
}));

jest.mock("@/lib/analytics/matomo", () => ({
  trackFunnelStep: jest.fn(),
  trackMatomoEvent: jest.fn(),
}));

import { OrderService } from "@/services";
import PaymentCallback from "./page";

const verifyPaymentMock = OrderService.verifyPayment as jest.Mock;
const paymentStatusMock = OrderService.getOrderPaymentStatus as jest.Mock;
const useCartMock = useCart as jest.Mock;
const trackFunnelStepMock = trackFunnelStep as jest.Mock;
const trackMatomoEventMock = trackMatomoEvent as jest.Mock;

describe("PaymentCallback page", () => {
  beforeEach(() => {
    currentSearchParams = { ResNum: "123", RefNum: "abc" };
    mockPush.mockReset();
    mockClearCart.mockReset();
    mockClearCart.mockResolvedValue(undefined);
    useCartMock.mockReset();
    useCartMock.mockReturnValue({ clearCart: mockClearCart });
    trackFunnelStepMock.mockReset();
    trackMatomoEventMock.mockReset();
    verifyPaymentMock.mockReset();
    paymentStatusMock.mockReset();
    localStorage.clear();
  });

  it("verifies payment, clears checkout state, tracks success, and redirects", async () => {
    verifyPaymentMock.mockResolvedValue({
      orderId: 1,
      orderNumber: "A123",
      success: true,
    });
    paymentStatusMock.mockResolvedValue({ isPaid: true });

    const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    render(<PaymentCallback />);

    await waitFor(() => {
      expect(verifyPaymentMock).toHaveBeenCalledWith(123, "abc");
    });

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orders/success");
    });

    expect(paymentStatusMock).toHaveBeenCalledWith(1);
    expect(mockClearCart).toHaveBeenCalled();
    expect(trackFunnelStepMock).toHaveBeenCalledWith("purchase", {
      label: "1",
      onceKey: "purchase:1",
    });
    expect(trackMatomoEventMock).toHaveBeenCalledWith({
      category: "checkout",
      action: "payment_callback_success",
      name: "verified",
      onceKey: "payment-callback-success:1",
    });
    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("falls back to verification success when direct payment status check fails", async () => {
    verifyPaymentMock.mockResolvedValue({
      orderId: 2,
      orderNumber: "A124",
      success: true,
    });
    paymentStatusMock.mockRejectedValue(new Error("status endpoint unavailable"));

    render(<PaymentCallback />);

    await waitFor(() => {
      expect(paymentStatusMock).toHaveBeenCalledWith(2);
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orders/success");
    });

    expect(mockClearCart).toHaveBeenCalled();
    expect(trackFunnelStepMock).toHaveBeenCalledWith("purchase", {
      label: "2",
      onceKey: "purchase:2",
    });
  });

  it("routes to failure when backend verification returns unsuccessful", async () => {
    verifyPaymentMock.mockResolvedValue({
      orderId: 3,
      orderNumber: "A125",
      success: false,
    });
    paymentStatusMock.mockResolvedValue({ isPaid: false });

    render(<PaymentCallback />);

    await waitFor(() => {
      expect(verifyPaymentMock).toHaveBeenCalledWith(123, "abc");
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orders/failure");
    });

    expect(mockClearCart).not.toHaveBeenCalled();
    expect(trackMatomoEventMock).toHaveBeenCalledWith({
      category: "checkout",
      action: "payment_callback_failed",
      name: "verification_failed",
      onceKey: "payment-callback-failed:3",
    });
  });

  it("routes to failure without calling verification when URL and storage params are missing", async () => {
    currentSearchParams = {};

    render(<PaymentCallback />);

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orders/failure");
    });

    expect(verifyPaymentMock).not.toHaveBeenCalled();
    expect(trackMatomoEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "checkout",
        action: "payment_callback_error",
        name: "MISSING_PARAMS",
        onceKey: "payment-callback-error:unknown:MISSING_PARAMS",
      }),
    );
  });

  it("renders the styled loading card while verification is in flight", async () => {
    // Keep verification pending so the loading state stays mounted.
    verifyPaymentMock.mockReturnValue(new Promise(() => {}));

    render(<PaymentCallback />);

    const loading = await screen.findByTestId("payment-callback-loading");
    expect(loading).toBeInTheDocument();
    expect(loading).toHaveTextContent("در حال بررسی وضعیت پرداخت...");
    // Spinner is present inside the card.
    expect(loading.querySelector(".animate-spin")).not.toBeNull();
  });

  it("routes to failure and tracks a stable error code when verification throws", async () => {
    verifyPaymentMock.mockRejectedValue(
      Object.assign(new Error("network down"), { code: "NETWORK_ERROR" }),
    );

    render(<PaymentCallback />);

    await waitFor(() => {
      expect(verifyPaymentMock).toHaveBeenCalledWith(123, "abc");
    });
    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith("/orders/failure");
    });

    expect(mockClearCart).not.toHaveBeenCalled();
    expect(trackMatomoEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "checkout",
        action: "payment_callback_error",
        name: "NETWORK_ERROR",
        onceKey: "payment-callback-error:123:NETWORK_ERROR",
      }),
    );
  });
});
