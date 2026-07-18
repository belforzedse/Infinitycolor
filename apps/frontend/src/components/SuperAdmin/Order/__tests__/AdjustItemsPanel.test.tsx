import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdjustItemsPanel from "../AdjustItemsPanel";

const previewAdjustItems = jest.fn();
const adjustItems = jest.fn();
const cancelOrder = jest.fn();

jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  previewAdjustItems: (...args: unknown[]) => previewAdjustItems(...args),
  adjustItems: (...args: unknown[]) => adjustItems(...args),
  cancelOrder: (...args: unknown[]) => cancelOrder(...args),
  voidShippingBarcode: jest.fn(),
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

const order = {
  id: 7,
  orderStatus: "Started",
  items: [{ id: 1, productName: "تیشرت", price: 20000, quantity: 5, image: "x.jpg" }],
  // No transactionId + paymentToken => not a SnappPay order, so wallet refund applies.
} as never;

describe("AdjustItemsPanel refund warning", () => {
  beforeEach(() => jest.clearAllMocks());

  it("shows the wallet refund amount prominently in the confirm step", async () => {
    previewAdjustItems.mockResolvedValue({
      preview: {
        newTotals: { subtotal: 40000, discount: 0, total: 40000 },
        newShipping: 0,
        refundToman: 60000,
      },
    });

    render(<AdjustItemsPanel order={order} onSuccess={jest.fn()} />);

    // Reduce quantity 5 -> 2
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2" } });
    fireEvent.click(screen.getByText("پیش‌نمایش تغییرات"));

    await waitFor(() => expect(previewAdjustItems).toHaveBeenCalled());

    fireEvent.click(screen.getByText("ثبت تغییرات"));

    const callout = await screen.findByTestId("adjust-refund-callout");
    expect(callout).toHaveTextContent("۶۰٬۰۰۰ تومان");
  });
});
