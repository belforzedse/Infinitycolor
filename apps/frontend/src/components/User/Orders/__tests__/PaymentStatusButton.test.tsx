import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import PaymentStatusButton from "../PaymentStatusButton";
import { OrderService } from "@/services";

jest.mock("@/services", () => ({
  OrderService: {
    getOrderPaymentStatus: jest.fn(),
  },
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: {
    error: jest.fn(),
  },
}));

jest.mock("@/utils/userErrorMessage", () => ({
  getUserFacingErrorMessage: jest.fn(() => "inline forbidden"),
}));

describe("PaymentStatusButton", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows forbidden payment-status errors inline", async () => {
    const consoleError = jest.spyOn(console, "error").mockImplementation();
    try {
      (OrderService.getOrderPaymentStatus as jest.Mock).mockRejectedValue({
        status: 403,
        message: "Forbidden",
      });

      render(<PaymentStatusButton orderId={123} />);

      fireEvent.click(screen.getByRole("button"));

      await waitFor(() => {
        expect(OrderService.getOrderPaymentStatus).toHaveBeenCalledWith(123);
      });

      expect(await screen.findByText("inline forbidden")).toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});
