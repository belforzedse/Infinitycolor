import { render, screen } from "@testing-library/react";
import OrderStatusActions from "../OrderStatusActions";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/services/super-admin/orders/adjustItems", () => ({
  changeOrderStatus: jest.fn(),
  cancelOrder: jest.fn(),
  formatSnappayOperationFailure: jest.fn(),
  waitForPaymentOperation: jest.fn(),
}));

jest.mock("@/components/Kits/ConfirmDialog", () => ({
  __esModule: true,
  default: () => null,
}));

function order(overrides: Partial<SuperAdminOrderDetail> = {}): SuperAdminOrderDetail {
  return {
    id: 111944,
    orderStatus: "Done",
    paymentGateway: "SnappPay",
    items: [],
    ...overrides,
  } as SuperAdminOrderDetail;
}

describe("OrderStatusActions cancel affordance", () => {
  it("keeps cancel available on Done and Shipment", () => {
    const { rerender } = render(
      <OrderStatusActions
        order={order({ orderStatus: "Done" })}
        onSuccess={jest.fn()}
        canChangeStatus
        canCancel
      />,
    );
    expect(screen.getByRole("button", { name: "لغو سفارش" })).toBeEnabled();

    rerender(
      <OrderStatusActions
        order={order({ orderStatus: "Shipment" })}
        onSuccess={jest.fn()}
        canChangeStatus
        canCancel
      />,
    );
    expect(screen.getByRole("button", { name: "لغو سفارش" })).toBeEnabled();
  });

  it("disables cancel on Returned and Cancelled", () => {
    const { rerender } = render(
      <OrderStatusActions
        order={order({ orderStatus: "Returned" })}
        onSuccess={jest.fn()}
        canChangeStatus
        canCancel
      />,
    );
    expect(screen.getByRole("button", { name: "لغو سفارش" })).toBeDisabled();

    rerender(
      <OrderStatusActions
        order={order({ orderStatus: "Cancelled" })}
        onSuccess={jest.fn()}
        canChangeStatus
        canCancel
      />,
    );
    expect(screen.getByRole("button", { name: "لغو سفارش" })).toBeDisabled();
  });
});
