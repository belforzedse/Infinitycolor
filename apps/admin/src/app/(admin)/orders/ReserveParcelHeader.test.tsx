import { fireEvent, render, screen } from "@testing-library/react";
import {
  ReserveParcelHeader,
  reserveParcelGrouping,
} from "./ReserveParcelHeader";
import type { Order } from "./table";

let mockCanPrint = true;
jest.mock("@/hooks/useCan", () => ({
  useCan: (capability: string) => capability === "order.print" && mockCanPrint,
}));

const row = {
  id: "101",
  attributes: {
    recipientName: "سارا احمدی",
    reserveGroupId: "reserve/parcel 1",
    reserveIsHeld: true,
  },
} as Order;

describe("reserve parcel header", () => {
  beforeEach(() => {
    mockCanPrint = true;
  });

  it("prints the entire parcel even if this page contains only one member", () => {
    const onToggle = jest.fn();
    render(
      <ReserveParcelHeader
        groupKey="reserve/parcel 1"
        rows={[row]}
        expanded={false}
        onToggle={onToggle}
      />,
    );
    expect(screen.getByText("۱ سفارش در این صفحه")).toBeVisible();
    expect(screen.getByText("بسته رزروی · سارا احمدی")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "چاپ فاکتور کل بسته" }),
    ).toHaveAttribute("href", "/orders/print/reserve/reserve%2Fparcel%201");
    expect(
      screen.getByRole("link", { name: "چاپ فاکتور کل بسته" }),
    ).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "جزئیات بسته" })).toHaveAttribute(
      "href",
      "/orders/reserve/reserve%2Fparcel%201",
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("uses the existing parcel print permission", () => {
    mockCanPrint = false;
    render(
      <ReserveParcelHeader
        groupKey="parcel"
        rows={[row]}
        expanded
        onToggle={jest.fn()}
      />,
    );
    expect(
      screen.queryByRole("link", { name: "چاپ فاکتور کل بسته" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { expanded: true })).toBeVisible();
  });

  it("uses the projected parcel key and leaves regular orders ungrouped", () => {
    expect(reserveParcelGrouping.getKey(row)).toBe("reserve/parcel 1");
    expect(
      reserveParcelGrouping.getKey({
        ...row,
        attributes: { ...row.attributes, reserveGroupId: null },
      }),
    ).toBeNull();
  });
});
