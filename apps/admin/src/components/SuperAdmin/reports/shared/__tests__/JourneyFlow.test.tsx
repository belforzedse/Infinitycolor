import { render, screen } from "@testing-library/react";
import type { JourneyNode, JourneyLink } from "../journeyFlow";

let lastSankeyProps: { data?: { nodes: JourneyNode[]; links: JourneyLink[] } } | null = null;

jest.mock("../charts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Sankey: (props: { data?: { nodes: JourneyNode[]; links: JourneyLink[] } }) => {
    lastSankeyProps = props;
    return <div data-testid="sankey">{props.data?.nodes.length ?? 0} nodes</div>;
  },
}));

class ImmediateResizeObserver {
  private callback: (entries: Array<{ contentRect: { width: number } }>) => void;
  constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
    this.callback = callback;
  }
  observe() {
    this.callback([{ contentRect: { width: 800 } }]);
  }
  unobserve() {}
  disconnect() {}
}

import JourneyFlow from "../JourneyFlow";

const EVENT_LABELS: Record<string, string> = {
  view_item: "مشاهده محصول",
  add_to_cart: "افزودن به سبد خرید",
  begin_checkout: "شروع ثبت سفارش",
  purchase: "خرید موفق",
};
const label = (raw: unknown) => EVENT_LABELS[String(raw ?? "")] ?? String(raw ?? "");

describe("JourneyFlow", () => {
  const originalResizeObserver = (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;

  beforeEach(() => {
    lastSankeyProps = null;
  });

  afterEach(() => {
    (global as unknown as { ResizeObserver?: unknown }).ResizeObserver = originalResizeObserver;
  });

  it("shows an empty state when there are no usable journey rows", () => {
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ImmediateResizeObserver;
    render(<JourneyFlow rows={[]} label={label} />);
    expect(screen.getByText("هنوز داده‌ای ثبت نشده است")).toBeInTheDocument();
    expect(screen.queryByTestId("sankey")).not.toBeInTheDocument();
  });

  it("passes a Persian-labeled node/link graph to the Sankey once the container is wide enough", async () => {
    (global as unknown as { ResizeObserver: unknown }).ResizeObserver = ImmediateResizeObserver;
    render(
      <JourneyFlow
        rows={[
          { e1: "view_item", e2: "add_to_cart", count: 12 },
          { e1: "view_item", e2: "add_to_cart", e3: "begin_checkout", e4: "purchase", count: 5 },
        ]}
        label={label}
      />,
    );

    expect(await screen.findByTestId("sankey")).toBeInTheDocument();
    expect(lastSankeyProps?.data?.nodes.map((n) => n.label)).toEqual(
      expect.arrayContaining(["مشاهده محصول", "افزودن به سبد خرید", "شروع ثبت سفارش", "خرید موفق", "پایان مسیر"]),
    );
    expect(lastSankeyProps?.data?.links.length).toBeGreaterThan(0);

    // One fixture row used all 4 steps, so the cap footnote must be shown.
    expect(
      screen.getByText(/آنچه پس از قدم چهارم رخ داده، در این داده دیده نمی‌شود/),
    ).toBeInTheDocument();
  });

  it("falls back to a ranked path list on narrow containers instead of rendering the Sankey", () => {
    // No ResizeObserver on the global (simulates jsdom/older browsers without
    // one) — the component should never crash and should stay on the list.
    delete (global as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    render(
      <JourneyFlow
        rows={[{ e1: "view_item", e2: "add_to_cart", count: 12 }]}
        label={label}
      />,
    );
    expect(screen.queryByTestId("sankey")).not.toBeInTheDocument();
    expect(screen.getByText(/مشاهده محصول ← افزودن به سبد خرید/)).toBeInTheDocument();
  });
});
