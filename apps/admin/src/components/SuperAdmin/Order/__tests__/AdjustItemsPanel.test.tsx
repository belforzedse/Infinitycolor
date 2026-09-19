import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import AdjustItemsPanel from "../AdjustItemsPanel";

const mockPreviewAdjustItems = jest.fn();
const mockAdjustItems = jest.fn();
const mockCancelOrder = jest.fn();
const mockToastError = jest.fn();

jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  previewAdjustItems: (...args: unknown[]) => mockPreviewAdjustItems(...args),
  adjustItems: (...args: unknown[]) => mockAdjustItems(...args),
  cancelOrder: (...args: unknown[]) => mockCancelOrder(...args),
  voidShippingBarcode: jest.fn(),
  waitForPaymentOperation: jest.fn(),
  formatSnappayOperationFailure: (_op: unknown, fallback: string) => fallback,
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: (...a: unknown[]) => mockToastError(...a) },
}));

jest.mock("@/components/Kits/Modal", () => ({
  __esModule: true,
  default: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) =>
    isOpen ? <div data-testid="modal">{children}</div> : null,
}));

const order: any = {
  id: 501,
  orderStatus: "پرداخت شده",
  shippingBarcode: null,
  paymentGateway: "mellat",
  items: [
    { id: 11, quantity: 2, title: "کالای ۱", unitPrice: 100_000 },
    { id: 12, quantity: 1, title: "کالای ۲", unitPrice: 50_000 },
  ],
};

/** Reduce one line, preview, then open the confirmation modal. */
const reachConfirm = async () => {
  fireEvent.change(screen.getAllByRole("spinbutton")[0], { target: { value: "1" } });
  fireEvent.click(screen.getByRole("button", { name: "پیش‌نمایش تغییرات" }));
  await waitFor(() => expect(mockPreviewAdjustItems).toHaveBeenCalled());
  fireEvent.click(await screen.findByRole("button", { name: "ثبت تغییرات" }));
  return screen.findByTestId("modal");
};

describe("AdjustItemsPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPreviewAdjustItems.mockResolvedValue({
      preview: {
        changes: [
          {
            orderItemId: 11,
            oldCount: 2,
            newCount: 1,
            productTitle: "کالای ۱",
            restockDelta: 1,
          },
        ],
        newTotals: { subtotal: 150_000, discount: 0, tax: 0, shipping: 0, total: 150_000 },
        oldTotal: 250_000,
        refundToman: 100_000,
        newShipping: 0,
      },
    });
  });

  it("names the adjustment so a retry is not paid out twice", async () => {
    mockAdjustItems
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { response: undefined }))
      .mockResolvedValueOnce({ status: "adjusted", refundToman: 100_000 });

    render(<AdjustItemsPanel order={order} onSuccess={jest.fn()} />);
    const modal = await reachConfirm();

    // The operator presses apply, the request times out, and they press again.
    fireEvent.click(within(modal).getByRole("button", { name: "ثبت تغییرات" }));
    await waitFor(() => expect(mockAdjustItems).toHaveBeenCalledTimes(1));
    fireEvent.click(within(modal).getByRole("button", { name: "ثبت تغییرات" }));
    await waitFor(() => expect(mockAdjustItems).toHaveBeenCalledTimes(2));

    const firstId = mockAdjustItems.mock.calls[0][3];
    const secondId = mockAdjustItems.mock.calls[1][3];
    expect(firstId).toEqual(expect.any(String));
    expect(firstId).toHaveLength(36);
    expect(secondId).toBe(firstId);
  });

  it("mints a new identity once the operator changes what they are adjusting", async () => {
    mockAdjustItems.mockRejectedValue(Object.assign(new Error("timeout"), {}));

    render(<AdjustItemsPanel order={order} onSuccess={jest.fn()} />);
    const modal = await reachConfirm();
    fireEvent.click(within(modal).getByRole("button", { name: "ثبت تغییرات" }));
    await waitFor(() => expect(mockAdjustItems).toHaveBeenCalledTimes(1));
    const firstId = mockAdjustItems.mock.calls[0][3];

    // A failed apply leaves the modal open; the operator backs out of it.
    fireEvent.click(within(modal).getByRole("button", { name: "انصراف" }));
    await waitFor(() => expect(screen.queryByTestId("modal")).not.toBeInTheDocument());

    // A different quantity is a different adjustment, not a retry of this one.
    fireEvent.change(screen.getAllByRole("spinbutton")[1], { target: { value: "0" } });
    const secondModal = await reachConfirm();
    fireEvent.click(within(secondModal).getByRole("button", { name: "ثبت تغییرات" }));
    await waitFor(() => expect(mockAdjustItems).toHaveBeenCalledTimes(2));

    expect(mockAdjustItems.mock.calls[1][3]).not.toBe(firstId);
  });

  it("explains a held-credit refusal instead of showing a raw error", async () => {
    mockAdjustItems.mockRejectedValue({
      response: { data: { data: { code: "ORDER_HAS_ACTIVE_WALLET_HOLD" } } },
    });

    render(<AdjustItemsPanel order={order} onSuccess={jest.fn()} />);
    const modal = await reachConfirm();
    fireEvent.click(within(modal).getByRole("button", { name: "ثبت تغییرات" }));

    await waitFor(() =>
      expect(mockToastError).toHaveBeenCalledWith(
        expect.stringContaining("رزرو شده"),
      ),
    );
  });
});
