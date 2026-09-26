import { render, screen } from "@testing-library/react";
import OrderRowActions from "../OrderRowActions";

const mockUseCan = jest.fn(() => true);
jest.mock("@/hooks/useCan", () => ({ useCan: (capability: string) => mockUseCan(capability) }));

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

  it("hides shipping actions when the actor lacks order.shipping.manage", () => {
    mockUseCan.mockImplementation((capability: string) => capability !== "order.shipping.manage");
    render(<OrderRowActions orderId="103634" orderStatus="Shipment" shippingMethodCode="post" anipoBarcodeState="NeedsAttention" />);
    expect(screen.queryByText(/نیاز به بررسی/)).not.toBeInTheDocument();
    expect(screen.getByTestId("admin-order-view")).toBeInTheDocument();
    mockUseCan.mockImplementation(() => true);
  });

  it("shows the Anipo review action to a shipping manager", () => {
    mockUseCan.mockImplementation((capability: string) =>
      capability === "order.read" || capability === "order.shipping.manage",
    );
    render(<OrderRowActions orderId="103635" orderStatus="Shipment" shippingMethodCode="post" anipoBarcodeState="NeedsAttention" anipoSubmittedAt="2026-09-20T00:00:00Z" />);
    expect(screen.getByRole("button", { name: /نیاز به بررسی — استعلام مجدد/ })).toBeInTheDocument();
    mockUseCan.mockImplementation(() => true);
  });
});
