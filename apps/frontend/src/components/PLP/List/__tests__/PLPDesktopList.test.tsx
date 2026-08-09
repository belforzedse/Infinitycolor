import { render } from "@testing-library/react";
import PLPDesktopList from "../PLPDesktopList";
import type { PLPProduct } from "@/components/PLP/types";
import { trackAnalyticsEvent } from "@/lib/analytics";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DynamicProductCard = (props: { id: number }) => (
      <div data-testid="product-card" data-id={props.id} />
    );
    return DynamicProductCard;
  },
}));

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => ({ media: "high" }),
}));

let pathname = "/plp";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

jest.mock("@/services/product/product", () => ({
  formatProductsToCardProps: (products: any[]) =>
    products.map((p) => ({
      id: p.id,
      images: ["/img.jpg"],
      category: "Category",
      title: `Product ${p.id}`,
      price: 1000,
      seenCount: 0,
    })),
}));

jest.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: jest.fn(),
}));

const trackAnalyticsEventMock = trackAnalyticsEvent as jest.Mock;

function makeProducts(ids: number[]): PLPProduct[] {
  return ids.map((id) => ({ id, attributes: { Title: `Product ${id}` } })) as PLPProduct[];
}

describe("PLPDesktopList", () => {
  beforeEach(() => {
    pathname = "/plp";
    trackAnalyticsEventMock.mockReset();
  });

  it("tracks view_item_list once for a given product list on the current path", () => {
    const { rerender } = render(<PLPDesktopList products={makeProducts([1, 2, 3])} />);

    expect(trackAnalyticsEventMock).toHaveBeenCalledWith({
      category: "ecommerce",
      action: "view_item_list",
      properties: { placement: "plp", result_count: 3 },
      onceKey: "view-item-list:/plp:1,2,3",
    });
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);

    // Re-render with the same product list — no duplicate event.
    rerender(<PLPDesktopList products={makeProducts([1, 2, 3])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);
  });

  it("tracks a new view_item_list when the product list changes (e.g. pagination)", () => {
    const { rerender } = render(<PLPDesktopList products={makeProducts([1, 2])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);

    rerender(<PLPDesktopList products={makeProducts([4, 5])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(2);
    expect(trackAnalyticsEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ onceKey: "view-item-list:/plp:4,5" }),
    );
  });

  it("does not track when the product list is empty", () => {
    render(<PLPDesktopList products={[]} />);
    expect(trackAnalyticsEventMock).not.toHaveBeenCalled();
  });
});
