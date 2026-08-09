import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DiscountCoupon from "../DiscountCoupon";
import { CartService } from "@/services";
import { trackAnalyticsEvent } from "@/lib/analytics";

jest.mock("@/services", () => ({
  CartService: {
    applyDiscount: jest.fn(),
  },
}));

jest.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const applyDiscountMock = CartService.applyDiscount as jest.Mock;
const trackAnalyticsEventMock = trackAnalyticsEvent as jest.Mock;

describe("DiscountCoupon", () => {
  beforeEach(() => {
    applyDiscountMock.mockReset();
    trackAnalyticsEventMock.mockReset();
  });

  it("tracks apply_coupon with only the discount amount on success", async () => {
    applyDiscountMock.mockResolvedValue({
      success: true,
      discount: 15000,
      summary: {
        subtotal: 100000,
        eligibleSubtotal: 100000,
        tax: 0,
        shipping: 0,
        total: 85000,
        taxPercent: 0,
      },
    });

    render(<DiscountCoupon />);
    fireEvent.change(screen.getByPlaceholderText("کد تخفیف را وارد نمایید"), {
      target: { value: "SUMMER10" },
    });
    fireEvent.click(screen.getByText("اعمال کد"));

    await waitFor(() => {
      expect(trackAnalyticsEventMock).toHaveBeenCalledWith({
        category: "ecommerce",
        action: "apply_coupon",
        valueToman: 15000,
      });
    });
  });

  it("does not track apply_coupon when the code is invalid", async () => {
    applyDiscountMock.mockResolvedValue({ success: false });

    render(<DiscountCoupon />);
    fireEvent.change(screen.getByPlaceholderText("کد تخفیف را وارد نمایید"), {
      target: { value: "BAD" },
    });
    fireEvent.click(screen.getByText("اعمال کد"));

    await waitFor(() => {
      expect(applyDiscountMock).toHaveBeenCalled();
    });
    expect(trackAnalyticsEventMock).not.toHaveBeenCalled();
  });
});
