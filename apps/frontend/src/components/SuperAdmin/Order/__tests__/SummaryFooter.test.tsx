import { render, screen } from "@testing-library/react";
import SuperAdminOrderSummaryFooter from "../SummaryFooter";
import type { SuperAdminOrderDetail } from "@/types/super-admin/order";

jest.mock("next/image", () => ({
  __esModule: true,
  default: () => null,
}));

const baseOrder = {
  id: 42,
  items: [],
  total: 1_000_000,
  shipping: 0,
  subtotal: 1_000_000,
  discount: 0,
  orderStatus: "Started",
  contractStatus: "Confirmed",
  paymentGateway: "SnappPay",
} as unknown as SuperAdminOrderDetail;

describe("SuperAdminOrderSummaryFooter payment token", () => {
  // The SnappPay payment token is not a secret we withhold from operators: it is
  // useless without our OAuth credentials, and support tickets need it verbatim.
  it("shows the SnappPay payment token when the order has one", () => {
    render(
      <SuperAdminOrderSummaryFooter
        order={{ ...baseOrder, paymentToken: "SNP-TOKEN-123" }}
      />,
    );

    expect(screen.getByText("توکن پرداخت اسنپ پی")).toBeInTheDocument();
    expect(screen.getByText("SNP-TOKEN-123")).toBeInTheDocument();
  });

  it("omits the token row for orders without a payment token", () => {
    render(
      <SuperAdminOrderSummaryFooter order={{ ...baseOrder, paymentToken: null }} />,
    );

    expect(screen.queryByText("توکن پرداخت اسنپ پی")).not.toBeInTheDocument();
  });
});
