import { render, screen } from "@testing-library/react";

import Invoice, { type InvoiceOrder } from "./invoice";

describe("printed invoice identity", () => {
  it("prints the customer-facing Infinity Color domain", () => {
    const order: InvoiceOrder = {
      id: "123",
      attributes: { order_items: { data: [] } },
    };

    render(<Invoice order={order} />);

    expect(screen.getByText("infinitycolor.co")).toBeInTheDocument();
    expect(
      screen.queryByText(/admin\.infinitycolor\.co/),
    ).not.toBeInTheDocument();
  });
});

describe("reserve order marker", () => {
  it("marks an order that belongs to a combined-shipping parcel", () => {
    const order: InvoiceOrder = {
      id: "123",
      attributes: { isReserveOrder: true, order_items: { data: [] } },
    };

    render(<Invoice order={order} />);

    expect(screen.getByTestId("invoice-reserve-flag")).toHaveTextContent(
      "سفارش رزروی",
    );
  });

  it("leaves an ordinary order unmarked", () => {
    const order: InvoiceOrder = {
      id: "123",
      attributes: { order_items: { data: [] } },
    };

    render(<Invoice order={order} />);

    expect(screen.queryByTestId("invoice-reserve-flag")).not.toBeInTheDocument();
  });
});
