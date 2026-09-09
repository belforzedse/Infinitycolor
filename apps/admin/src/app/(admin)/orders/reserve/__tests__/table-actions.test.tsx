import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CellContext } from "@tanstack/react-table";
import { reserveGroupColumns } from "../table";
import type { AdminReserveGroup } from "@/services/super-admin/orders/reserveGroups";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: {
    children: ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const group: AdminReserveGroup = {
  id: 1,
  groupKey: "grp-1",
  state: "Active",
  closureReason: null,
  isHeld: true,
  customer: { id: 5, phone: "09120000000", firstName: "سارا", lastName: "احمدی" },
  rootOrderId: 41,
  orderCount: 2,
  itemCount: 4,
  groupValue: 500_000,
  shippingCostPaid: 20_000,
  shippingMethodTitle: "پست پیشتاز",
  shippingMethodCode: "post",
  shippingBarcode: null,
  destination: "تهران، تهران",
  activatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 20 * 3_600_000).toISOString(),
  closedAt: null,
  remainingMs: 20 * 3_600_000,
  lastOrderAttachedAt: null,
  lastActivityAt: new Date().toISOString(),
};

describe("reserve group operations cell", () => {
  it("uses an icon-only view action instead of a wide مدیریت بسته button", () => {
    const operations = reserveGroupColumns.find((column) => column.accessorKey === "id");
    const renderCell = operations?.cell;
    expect(typeof renderCell).toBe("function");

    render(
      (
        renderCell as (
          context: Pick<CellContext<AdminReserveGroup, unknown>, "row">,
        ) => ReactNode
      )({
        row: { original: group } as CellContext<AdminReserveGroup, unknown>["row"],
      }),
    );

    expect(screen.queryByText("مدیریت بسته")).not.toBeInTheDocument();
    const link = screen.getByRole("link", { name: "مشاهده بسته" });
    expect(link).toHaveAttribute("href", "/orders/reserve/grp-1");
    expect(link).toHaveAttribute("data-testid", "admin-reserve-group-view");
  });
});
