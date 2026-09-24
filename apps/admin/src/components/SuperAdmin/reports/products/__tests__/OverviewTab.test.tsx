import { render, screen } from "@testing-library/react";

const getProductOverviewMock = jest.fn();
jest.mock("@/services/super-admin/reports/products", () => ({
  getProductOverview: (...args: unknown[]) => getProductOverviewMock(...args),
}));

import OverviewTab from "../OverviewTab";

const delta = (current: number, previous: number) => ({
  current,
  previous,
  change: current - previous,
  changePct: previous ? ((current - previous) / previous) * 100 : null,
});

function response(range: { start: string; end: string }, previous: { start: string; end: string }) {
  return {
    // The endpoint serialises Date objects: windows arrive as instants.
    range,
    previous,
    timezone: "Asia/Tehran",
    lowStockThreshold: 5,
    kpis: {
      gross: delta(2_000_000, 1_000_000),
      net: delta(1_500_000, 900_000),
      units: delta(10, 8),
      orders: delta(5, 4),
      avgPrice: delta(200_000, 125_000),
      aov: delta(400_000, 250_000),
      discounts: delta(100_000, 50_000),
      refunds: delta(0, 50_000),
    },
    inventory: { activeProducts: 10, inStock: 8, lowStock: 1, outStock: 1, totalVariations: 30 },
    notes: {},
  };
}

describe("product report overview tab", () => {
  it("renders with windows sent as instants and compares a full previous window", async () => {
    getProductOverviewMock.mockResolvedValue(
      response(
        { start: "2026-09-19T20:30:00.000Z", end: "2026-09-25T20:29:59.999Z" },
        { start: "2026-09-13T20:30:00.000Z", end: "2026-09-19T20:29:59.999Z" },
      ),
    );
    render(<OverviewTab start="2026-09-20" end="2026-09-25" />);
    expect(await screen.findByText("۲٬۰۰۰٬۰۰۰ تومان")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "فروش ناخالص محصولات", level: 3 })).toBeInTheDocument();
    expect(screen.getAllByText(/دوره قبل:/).length).toBeGreaterThan(0);
  });

  it("says why there is no comparison when the floor emptied the previous window", async () => {
    getProductOverviewMock.mockResolvedValue(
      response(
        { start: "2026-09-13T20:30:00.000Z", end: "2026-09-25T20:29:59.999Z" },
        { start: "2026-09-13T20:30:00.000Z", end: "2026-09-13T20:29:59.999Z" },
      ),
    );
    render(<OverviewTab start="2026-09-14" end="2026-09-25" />);
    expect((await screen.findAllByText(/دوره قبل پیش از ۲۳ شهریور/)).length).toBeGreaterThan(0);
  });
});
