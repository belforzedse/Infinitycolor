import { render, screen } from "@testing-library/react";
import type { SalesBreakdownRow } from "@/services/super-admin/reports/salesBreakdown";

let lastChoroplethProps: {
  data?: Array<{ name: string; value: number }>;
  width?: number;
  height?: number;
  renderTooltipContent?: (provinceData: { name: string; value: number } | null) => string;
} | null = null;

jest.mock("next/dynamic", () => {
  return (loader: () => Promise<unknown>) => {
    const DynamicComponent = (props: Record<string, unknown>) => {
      const React = require("react") as typeof import("react");
      const [Comp, setComp] = React.useState<React.ComponentType<Record<string, unknown>> | null>(
        null,
      );
      React.useEffect(() => {
        void Promise.resolve(loader()).then((mod) => {
          const resolved =
            typeof mod === "function"
              ? (mod as React.ComponentType<Record<string, unknown>>)
              : ((mod as { default?: React.ComponentType<Record<string, unknown>> }).default ??
                (mod as { ChoroplethMap?: React.ComponentType<Record<string, unknown>> })
                  .ChoroplethMap);
          if (resolved) setComp(() => resolved);
        });
      }, []);
      return Comp ? React.createElement(Comp, props) : null;
    };
    return DynamicComponent;
  };
});

jest.mock("react-iran-maps", () => ({
  ChoroplethMap: (props: {
    data?: Array<{ name: string; value: number }>;
    width?: number;
    height?: number;
    renderTooltipContent?: (provinceData: { name: string; value: number } | null) => string;
  }) => {
    lastChoroplethProps = props;
    return <div data-testid="choropleth">{props.data?.length ?? 0} provinces</div>;
  },
}));

import SalesGeographyMap from "../SalesGeographyMap";

function mockResizeObserverWidth(width: number) {
  class StubResizeObserver {
    private callback: (entries: Array<{ contentRect: { width: number } }>) => void;
    constructor(callback: (entries: Array<{ contentRect: { width: number } }>) => void) {
      this.callback = callback;
    }
    observe() {
      this.callback([{ contentRect: { width } }]);
    }
    unobserve() {}
    disconnect() {}
  }
  (global as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;
}

function row(
  partial: Partial<SalesBreakdownRow> & Pick<SalesBreakdownRow, "key" | "label">,
): SalesBreakdownRow {
  return {
    ordersCount: 1,
    units: 1,
    grossToman: 100,
    discountsToman: 0,
    refundsToman: 0,
    netToman: 100,
    ...partial,
  };
}

describe("SalesGeographyMap", () => {
  const originalResizeObserver = (global as unknown as { ResizeObserver?: unknown })
    .ResizeObserver;

  beforeEach(() => {
    lastChoroplethProps = null;
  });

  afterEach(() => {
    (global as unknown as { ResizeObserver?: unknown }).ResizeObserver =
      originalResizeObserver;
  });

  it("excludes the unmapped ('') row from the map and surfaces a notice", async () => {
    render(
      <SalesGeographyMap
        rows={[
          row({ key: "تهران", label: "تهران", ordersCount: 5, units: 8, netToman: 500 }),
          row({ key: "", label: "نامشخص", ordersCount: 2, netToman: 200 }),
        ]}
      />,
    );

    expect(await screen.findByTestId("choropleth")).toBeInTheDocument();
    expect(lastChoroplethProps?.data).toEqual([{ name: "تهران", value: 500 }]);
    expect(screen.getByText(/سفارش بدون آدرس تحویل قابل‌شناسایی/)).toBeInTheDocument();
    expect(screen.getByText("برترین استان")).toBeInTheDocument();
    expect(screen.getByText("تهران")).toBeInTheDocument();
  });

  it("renders a large map frame and passes wide choropleth dimensions", async () => {
    mockResizeObserverWidth(1100);
    render(
      <SalesGeographyMap
        rows={[row({ key: "تهران", label: "تهران", ordersCount: 5, netToman: 500 })]}
      />,
    );

    await screen.findByTestId("choropleth");
    // The frame's minHeight must always track the actual map height passed to
    // the choropleth so it never wraps a box taller than the map it contains.
    expect(screen.getByTestId("geography-map-frame")).toHaveStyle({
      minHeight: `${lastChoroplethProps?.height}px`,
    });
    expect(lastChoroplethProps?.width).toBeGreaterThanOrEqual(800);
    expect(lastChoroplethProps?.height).toBeGreaterThanOrEqual(560);
  });

  it("does not force the 560px desktop floor on narrow (mobile) frames", async () => {
    // A phone-width frame: forcing the desktop min-height here would leave a
    // large blank strip below the aspect-locked map (the "بدنمایش میده" bug).
    mockResizeObserverWidth(360);
    render(
      <SalesGeographyMap
        rows={[row({ key: "تهران", label: "تهران", ordersCount: 5, netToman: 500 })]}
      />,
    );

    await screen.findByTestId("choropleth");
    expect(lastChoroplethProps?.width).toBe(360);
    expect(lastChoroplethProps?.height).toBeLessThan(560);
    expect(screen.getByTestId("geography-map-frame")).toHaveStyle({
      minHeight: `${lastChoroplethProps?.height}px`,
    });
  });

  it("renders nothing when there are no mappable rows and no unmapped orders", () => {
    const { container } = render(<SalesGeographyMap rows={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("choropleth")).not.toBeInTheDocument();
  });

  it("escapes tooltip HTML and includes order/unit details", async () => {
    render(
      <SalesGeographyMap
        rows={[
          row({
            key: "x",
            label: '<img src=x onerror=alert(1)>',
            ordersCount: 4,
            units: 7,
            netToman: 1000,
          }),
        ]}
      />,
    );

    await screen.findByTestId("choropleth");
    const html = lastChoroplethProps?.renderTooltipContent?.({
      name: '<img src=x onerror=alert(1)>',
      value: 1000,
    });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).toContain("سفارش‌ها");
    expect(html).toContain("تعداد کالا");
  });
});
