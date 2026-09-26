import { render, screen, within } from "@testing-library/react";
import Invoice, { type InvoiceOrder } from "@/components/invoice";
import type { AdminReserveGroupDetail } from "@/services/super-admin/orders/reserveGroups";
import { combineReserveOrders } from "./combineReserveOrders";

const group: AdminReserveGroupDetail = {
  id: 7,
  groupKey: "reserve-group-7",
  state: "ReadyToFulfill",
  closureReason: null,
  isHeld: false,
  customer: { id: 5, phone: "09120000000", firstName: "سارا", lastName: "احمدی" },
  rootOrderId: 41,
  orderCount: 2,
  itemCount: 3,
  groupValue: 260,
  shippingCostPaid: 30,
  shippingMethodTitle: "پست پیشتاز",
  shippingMethodCode: "post",
  shippingBarcode: null,
  destination: "تهران",
  activatedAt: null,
  expiresAt: null,
  closedAt: null,
  remainingMs: null,
  lastOrderAttachedAt: null,
  lastActivityAt: null,
  orders: [
    { id: 41, status: "Started", date: null, amount: 210, contractStatus: null, itemCount: 2 },
    { id: 42, status: "Started", date: null, amount: 50, contractStatus: null, itemCount: 1 },
  ],
};

const root: InvoiceOrder = {
  id: "41",
  attributes: {
    isReserveOrder: true,
    PaymentGateway: "ZarinPal",
    gatewayTrackingCode: "root-payment-only",
    ShippingCost: 30,
    AppliedDiscountAmount: 20,
    order_items: { data: [{ id: "1", attributes: { ProductTitle: "محصول اول", Count: 2, PerAmount: 100 } }] },
    contract: { data: { attributes: { Amount: 210 } } },
  },
};

const attached: InvoiceOrder = {
  id: "42",
  attributes: {
    isReserveOrder: true,
    PaymentGateway: "Wallet",
    gatewayTrackingCode: "attached-payment-only",
    ShippingCost: 0,
    order_items: { data: [{ id: "2", attributes: { ProductTitle: "محصول دوم", Count: 1, PerAmount: 50 } }] },
    contract: { data: { attributes: { Amount: 50 } } },
  },
};

describe("combined reserve invoice", () => {
  it("prints every member item and the sum as one invoice", () => {
    const combined = combineReserveOrders(group, [root, attached]);
    render(<Invoice order={combined} />);

    const document = screen.getByTestId("invoice-document");
    expect(within(document).getByText("محصول اول")).toBeInTheDocument();
    expect(within(document).getByText("محصول دوم")).toBeInTheDocument();
    expect(within(document).getByText("reserve-group-7")).toBeInTheDocument();
    expect(within(document).getByText("#41، #42")).toBeInTheDocument();
    expect(within(document).getByText("پرداخت‌های جداگانه")).toBeInTheDocument();
    expect(within(document).queryByText("root-payment-only")).not.toBeInTheDocument();
    expect(within(document).queryByTestId("invoice-barcode")).not.toBeInTheDocument();
    expect(within(document).getByRole("table", { name: "جمع فاکتور" })).toHaveTextContent("۲۶۰ تومان");
    expect(within(document).getByRole("table", { name: "جمع فاکتور" })).toHaveTextContent("۳۰ تومان");
  });

  it("refuses to print a partial or stale group", () => {
    expect(() => combineReserveOrders(group, [root])).toThrow("همه سفارش‌های بسته");
    expect(() => combineReserveOrders(group, [root, { ...attached, id: "99" }])).toThrow(
      "همه سفارش‌های بسته",
    );
    expect(() =>
      combineReserveOrders({ ...group, itemCount: 4 }, [root, attached]),
    ).toThrow("اقلام بسته تغییر کرده‌اند");
  });
});
