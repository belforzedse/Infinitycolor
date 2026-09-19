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

describe("order-specific recipient", () => {
  it("prefers recipient name and phone from the order address snapshot", () => {
    const order: InvoiceOrder = {
      id: "123",
      attributes: {
        order_items: { data: [] },
        user: {
          data: {
            attributes: {
              Phone: "+989111111111",
              user_info: {
                data: { attributes: { FirstName: "نام", LastName: "مشتری" } },
              },
            },
          },
        },
        delivery_address: {
          data: {
            attributes: {
              FullName: "گیرنده سفارش",
              Phone: "+989122222222",
              FullAddress: "نشانی سفارش",
            },
          },
        },
      },
    };

    render(<Invoice order={order} />);
    expect(screen.getByText("گیرنده سفارش")).toBeInTheDocument();
    expect(screen.getByText("+989122222222")).toBeInTheDocument();
    expect(screen.queryByText("نام مشتری")).not.toBeInTheDocument();
    expect(screen.queryByText("+989111111111")).not.toBeInTheDocument();
  });
});

describe("printed product line", () => {
  const lineFor = (attributes: Record<string, unknown>) => {
    const order: InvoiceOrder = {
      id: "123",
      attributes: {
        order_items: {
          data: [{ id: "1", attributes: { Count: 1, PerAmount: 299000, ...attributes } }],
        },
      },
    };
    render(<Invoice order={order} />);
  };

  const relation = (Title: string) => ({ data: { attributes: { Title } } });

  it("prints every attribute of the variation in one list", () => {
    lineFor({
      ProductTitle: "شورت",
      product_color: relation("قرمز"),
      product_size: relation("XL"),
      customAttributeLabel: "راه راه",
    });

    expect(screen.getByText("شورت، قرمز، XL، راه راه")).toBeInTheDocument();
  });

  // The reported invoice: the «کد» was dropped whenever the variation also had a
  // size, so four different variations printed as the same «…، XL» line.
  it("prints a custom attribute next to the size, not instead of it", () => {
    lineFor({
      ProductTitle: "شورت طرحدار 00691 Y",
      product_size: relation("XL"),
      customAttributeLabel: "کد ۱",
    });

    expect(screen.getByText("شورت طرحدار 00691 Y، XL، کد ۱")).toBeInTheDocument();
  });

  it("prints the bare title when the line has no attributes", () => {
    lineFor({ ProductTitle: "شورت" });

    expect(screen.getByText("شورت")).toBeInTheDocument();
  });
});
