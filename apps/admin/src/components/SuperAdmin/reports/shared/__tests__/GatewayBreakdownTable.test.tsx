import { render, screen, within } from "@testing-library/react";
import GatewayBreakdownTable from "../GatewayBreakdownTable";
import type { GatewayBreakdownRow } from "@/services/super-admin/reports/products";

/**
 * The row counts (109 + 10 + 23 = 142) read as a wrong sum against the 135
 * paid orders unless the footer shows why: seven wallet + gateway splits sit
 * under two rows each. These are the prod figures of 2026-09-27 that raised it.
 */
const ROWS: GatewayBreakdownRow[] = [
  { gateway: "SnappPay", label: "اسنپ‌پی", ordersCount: 109, totalOrdersCount: 109, total: 444_584_009, sharePct: 64.71 },
  { gateway: "Wallet", label: "کیف پول", ordersCount: 10, totalOrdersCount: 10, total: 176_992_000, sharePct: 25.76 },
  { gateway: "SamanKish", label: "سامان کیش", ordersCount: 23, totalOrdersCount: 23, total: 65_425_000, sharePct: 9.52 },
];
const TOTAL = 687_001_009;

function footerRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll("tfoot tr")) as HTMLElement[];
}

describe("GatewayBreakdownTable footer", () => {
  it("splits the paid orders into single-channel and mixed so both columns add up", () => {
    const { container } = render(
      <GatewayBreakdownTable
        rows={ROWS}
        totalSales={TOTAL}
        ordersCount={135}
        paymentMix={{
          singleOrdersCount: 128,
          singleTotal: 652_815_009,
          mixedOrdersCount: 7,
          mixedTotal: 34_186_000,
        }}
      />,
    );

    const [single, mixed, total] = footerRows(container);
    expect(footerRows(container)).toHaveLength(3);

    expect(within(single).getByText("پرداخت با یک روش")).toBeInTheDocument();
    expect(single.textContent).toContain("۱۲۸");

    expect(within(mixed).getByText("پرداخت ترکیبی")).toBeInTheDocument();
    expect(mixed.textContent).toContain("۷");
    // 142 row appearances − 128 single = 14: each split counted under two rows.
    expect(mixed.textContent).toContain("جمعاً ۱۴ بار");

    expect(within(total).getByText("مجموع سفارش‌های پرداخت‌شده")).toBeInTheDocument();
    expect(total.textContent).toContain("۱۳۵");
  });

  it("names paid orders that sit under no row instead of letting the split fall short", () => {
    const { container } = render(
      <GatewayBreakdownTable
        rows={[{ ...ROWS[0], ordersCount: 0, total: 0, sharePct: null }]}
        totalSales={0}
        ordersCount={4}
        paymentMix={{ singleOrdersCount: 0, singleTotal: 0, mixedOrdersCount: 0, mixedTotal: 0 }}
      />,
    );

    const rows = footerRows(container);
    expect(rows).toHaveLength(4);
    expect(within(rows[2]).getByText("بدون تراکنش موفق")).toBeInTheDocument();
    expect(rows[2].textContent).toContain("۴");
    expect(screen.queryByText(/جمعاً/)).not.toBeInTheDocument();
  });

  it("keeps the single total row against an API without paymentMix", () => {
    const { container } = render(<GatewayBreakdownTable rows={ROWS} totalSales={TOTAL} ordersCount={135} />);

    const rows = footerRows(container);
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("مجموع")).toBeInTheDocument();
    expect(rows[0].textContent).toContain("۱۳۵");
  });
});
