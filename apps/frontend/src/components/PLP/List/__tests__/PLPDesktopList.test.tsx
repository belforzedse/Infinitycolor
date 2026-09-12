import { render, screen } from "@testing-library/react";
import PLPDesktopList from "../PLPDesktopList";
import type { ProductCardProps } from "@/components/Product/Card";
import { trackAnalyticsEvent } from "@/lib/analytics";

jest.mock("next/dynamic", () => ({
  __esModule: true,
  default: () => {
    const DynamicProductCard = (props: { id: number; images: string[] }) => (
      <div data-testid="product-card" data-id={props.id} data-image-count={props.images.length} />
    );
    return DynamicProductCard;
  },
}));

let media = "high";
jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => ({ media }),
}));

let pathname = "/plp";
jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
}));

jest.mock("@/lib/analytics", () => ({
  trackAnalyticsEvent: jest.fn(),
}));

const trackAnalyticsEventMock = trackAnalyticsEvent as jest.Mock;

function makeCards(ids: number[], images: string[] = ["/img.jpg"]): ProductCardProps[] {
  return ids.map((id) => ({
    id,
    images,
    category: "Category",
    title: `Product ${id}`,
    price: 1000,
    seenCount: 0,
  }));
}

describe("PLPDesktopList", () => {
  beforeEach(() => {
    pathname = "/plp";
    media = "high";
    trackAnalyticsEventMock.mockReset();
  });

  it("tracks view_item_list once for a given product list on the current path", () => {
    const { rerender } = render(<PLPDesktopList cards={makeCards([1, 2, 3])} />);

    expect(trackAnalyticsEventMock).toHaveBeenCalledWith({
      category: "ecommerce",
      action: "view_item_list",
      properties: { placement: "plp", result_count: 3 },
      onceKey: "view-item-list:/plp:1,2,3",
    });
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);

    // Re-render with the same product list — no duplicate event.
    rerender(<PLPDesktopList cards={makeCards([1, 2, 3])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);
  });

  it("tracks a new view_item_list when the product list changes (e.g. pagination)", () => {
    const { rerender } = render(<PLPDesktopList cards={makeCards([1, 2])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(1);

    rerender(<PLPDesktopList cards={makeCards([4, 5])} />);
    expect(trackAnalyticsEventMock).toHaveBeenCalledTimes(2);
    expect(trackAnalyticsEventMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ onceKey: "view-item-list:/plp:4,5" }),
    );
  });

  it("does not track when the product list is empty", () => {
    render(<PLPDesktopList cards={[]} />);
    expect(trackAnalyticsEventMock).not.toHaveBeenCalled();
  });

  it("renders one card per projected entry without reprojecting", () => {
    render(<PLPDesktopList cards={makeCards([1, 2, 3])} />);
    expect(screen.getAllByTestId("product-card")).toHaveLength(3);
  });

  it("keeps every image at high media and only the cover below it", () => {
    const images = ["/cover.jpg", "/alt-1.jpg", "/alt-2.jpg"];

    const { rerender } = render(<PLPDesktopList cards={makeCards([1], images)} />);
    expect(screen.getByTestId("product-card")).toHaveAttribute("data-image-count", "3");

    media = "economy";
    rerender(<PLPDesktopList cards={makeCards([1], images)} />);
    expect(screen.getByTestId("product-card")).toHaveAttribute("data-image-count", "1");
  });
});
