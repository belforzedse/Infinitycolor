import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import OrderStatusActions from "../OrderStatusActions";

const revealSnappaySupportToken = jest.fn();
const toastSuccess = jest.fn();

jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  changeOrderStatus: jest.fn(),
  cancelOrder: jest.fn(),
  waitForPaymentOperation: jest.fn(),
  revealSnappaySupportToken: (...args: unknown[]) => revealSnappaySupportToken(...args),
}));
jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: jest.fn(),
  },
}));

const snappayOrder = {
  id: 42,
  orderStatus: "Started",
  paymentGateway: "SnappPay",
  items: [],
} as never;

describe("OrderStatusActions SnappPay support token", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    revealSnappaySupportToken.mockResolvedValue({
      paymentToken: "support-token-value",
      transactionId: "ABC1234567",
      providerStatus: "SETTLE",
      fingerprint: "abc123",
    });
  });

  it("keeps the token hidden until the explicit reveal action", async () => {
    render(<OrderStatusActions order={snappayOrder} onSuccess={jest.fn()} />);

    expect(screen.queryByText("support-token-value")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "نمایش توکن" }));

    expect(await screen.findByText("support-token-value")).toBeInTheDocument();
    expect(revealSnappaySupportToken).toHaveBeenCalledWith(42);
    expect(toastSuccess).toHaveBeenCalledWith("توکن اسنپ‌پی نمایش داده شد و این دسترسی ثبت شد.");
  });

  it("copies and can hide a revealed token", async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<OrderStatusActions order={snappayOrder} onSuccess={jest.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "نمایش توکن" }));
    await screen.findByText("support-token-value");
    fireEvent.click(screen.getByRole("button", { name: "کپی توکن" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("support-token-value"));

    fireEvent.click(screen.getByRole("button", { name: "پنهان کردن" }));
    expect(screen.queryByText("support-token-value")).not.toBeInTheDocument();
  });
});
