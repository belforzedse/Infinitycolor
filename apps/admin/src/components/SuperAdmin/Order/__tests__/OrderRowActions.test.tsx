import { render, screen } from "@testing-library/react";
import OrderRowActions from "../OrderRowActions";

jest.mock("jotai", () => ({
  atom: () => ({}),
  useAtom: () => [false, jest.fn()],
}));

jest.mock("react-hot-toast", () => ({
  __esModule: true,
  default: { success: jest.fn(), error: jest.fn() },
}));

jest.mock("@/components/SuperAdmin/Table", () => ({
  refreshTable: {},
}));

jest.mock("../AnipoBarcodeDialog", () => ({
  __esModule: true,
  default: () => null,
}));

describe("OrderRowActions", () => {
  it("lets the Anipo label wrap instead of forcing a rigid side column", () => {
    render(
      <OrderRowActions
        orderId="103634"
        orderStatus="Cancelled"
        shippingMethodCode="post"
      />,
    );

    const cluster = screen.getByTestId("admin-order-row-actions");
    expect(cluster).toHaveClass("w-full", "min-w-0", "flex-wrap");
    expect(screen.getByText("ابتدا سفارش را آماده‌سازی کنید")).toHaveClass(
      "break-words",
    );
  });
});
