import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ProductCardProps } from "@/components/Product/Card";
import type { AdaptiveQualitySnapshot } from "@/lib/adaptive-quality";
import OffersListHomePage from "../OffersListHomePage";

let mockQuality: AdaptiveQualitySnapshot = {
  enabled: true,
  rendering: "standard",
  media: "standard",
  motion: "standard",
  reducedTransparency: false,
  reason: "default",
  routeGeneration: 0,
};
const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => mockQuality,
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

jest.mock("@/components/Product/Card", () => ({
  __esModule: true,
  default: ({ id }: { id: number }) => <div data-testid="home-product-card" data-product-id={id} />,
}));

const products = Array.from({ length: 12 }, (_, index) => ({
  id: index + 1,
})) as ProductCardProps[];

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
  });
}

function renderedProductIds(): string[] {
  return screen
    .getAllByTestId("home-product-card")
    .map((card) => card.getAttribute("data-product-id") || "");
}

describe("OffersListHomePage", () => {
  beforeEach(() => {
    setViewportWidth(1440);
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    mockQuality = {
      enabled: true,
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
    mockNoteEnhancementLoaded.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("keeps the responsive JavaScript card limits and paginates every product", async () => {
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products}
      />,
    );

    expect(
      screen.getAllByTestId("home-product-card")[0].parentElement?.parentElement,
    ).toHaveAttribute("data-products-per-page", "4");
    expect(
      screen.getAllByTestId("home-product-card")[0].closest("[data-aq-carousel]"),
    ).toHaveAttribute("data-aq-carousel-motion", "lightweight");
    expect(renderedProductIds()).toEqual(["1", "2", "3", "4"]);

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(renderedProductIds()).toEqual(["5", "6", "7", "8"]);

    act(() => {
      setViewportWidth(2560);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(renderedProductIds()).toEqual(["1", "2", "3", "4", "5", "6"]);
    });
  });

  it("renders two cards on narrow screens and keeps the rest reachable", () => {
    setViewportWidth(390);
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="محبوب ترین ها"
        products={products}
      />,
    );

    expect(renderedProductIds()).toEqual(["1", "2"]);
    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(renderedProductIds()).toEqual(["3", "4"]);
    expect(screen.getByRole("link", { name: "مشاهده محصولات بیشتر" })).toHaveAttribute(
      "href",
      "/plp?sort=AverageRating:desc",
    );
  });

  it("restores the legacy fade/scale page switch only for Enhanced", () => {
    jest.useFakeTimers();
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    };

    const view = render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products}
      />,
    );
    const carousel = view.container.querySelector('[data-aq-carousel="product-rail"]');
    const track = view.container.querySelector("[data-aq-carousel-track]");

    expect(carousel).toHaveAttribute("data-aq-carousel-motion", "legacy-rich");
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
    expect(track).toHaveClass("duration-300", "scale-100", "opacity-100");

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(renderedProductIds()).toEqual(["1", "2", "3", "4"]);
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "transitioning");
    expect(track).toHaveClass("scale-95", "opacity-0");
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("carousel-motion");

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(renderedProductIds()).toEqual(["5", "6", "7", "8"]);
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "transitioning");

    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
    expect(track).toHaveClass("scale-100", "opacity-100");

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    mockQuality = {
      ...mockQuality,
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reason: "repeated-long-task",
    };
    view.rerender(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products}
      />,
    );

    expect(renderedProductIds()).toEqual(["9", "10", "11", "12"]);
    expect(carousel).toHaveAttribute("data-aq-carousel-motion", "lightweight");
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
    expect(jest.getTimerCount()).toBe(0);
  });

  it("settles a pending rich switch when hidden and cleans timers on unmount", () => {
    jest.useFakeTimers();
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    };
    const view = render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products}
      />,
    );
    const carousel = view.container.querySelector('[data-aq-carousel="product-rail"]');
    const baselineTimerCount = jest.getTimerCount();

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(jest.getTimerCount()).toBeGreaterThan(baselineTimerCount);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(renderedProductIds()).toEqual(["5", "6", "7", "8"]);
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
    expect(jest.getTimerCount()).toBe(baselineTimerCount);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(jest.getTimerCount()).toBeGreaterThan(baselineTimerCount);
    view.unmount();
    expect(jest.getTimerCount()).toBeLessThanOrEqual(baselineTimerCount);
  });
});
