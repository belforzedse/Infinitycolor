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

/**
 * Desktop paging now hides cards instead of unmounting them, so "which products
 * does this page show" is a CSS question. jsdom applies no stylesheet, so this
 * resolves the responsive display utilities the way the cascade would: the last
 * declaration whose breakpoint is at or below the current tier wins.
 */
const TIERS = ["lg", "xl", "2xl", "3xl", "4xl"] as const;
type Tier = (typeof TIERS)[number];

function visibleAtTier(className: string, tier: Tier): boolean {
  const ceiling = TIERS.indexOf(tier);
  let visible = true;
  for (const token of className.split(/\s+/)) {
    const match = /^(lg|xl|2xl|3xl|4xl):(block|hidden)$/.exec(token);
    if (!match) continue;
    const index = TIERS.indexOf(match[1] as Tier);
    if (index <= ceiling) visible = match[2] === "block";
  }
  return visible;
}

function desktopVisibleIds(tier: Tier): string[] {
  return screen
    .getAllByTestId("home-product-card")
    .filter((card) => visibleAtTier(card.parentElement?.className || "", tier))
    .map((card) => card.getAttribute("data-product-id") || "");
}

function railTrack(container: HTMLElement): HTMLElement {
  return container.querySelector("[data-aq-home-product-list]") as HTMLElement;
}

function mobileViewAllLink(): HTMLElement {
  const link = screen
    .getAllByRole("link", { name: "مشاهده همه" })
    .find((candidate) => candidate.parentElement?.classList.contains("md:hidden"));
  if (!link) throw new Error("Mobile view-all link not found");
  return link;
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
    expect(desktopVisibleIds("xl")).toEqual(["1", "2", "3", "4"]);

    fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    expect(desktopVisibleIds("xl")).toEqual(["5", "6", "7", "8"]);

    act(() => {
      setViewportWidth(2560);
      window.dispatchEvent(new Event("resize"));
    });

    await waitFor(() => {
      expect(desktopVisibleIds("4xl")).toEqual(["1", "2", "3", "4", "5", "6"]);
    });
  });

  it("keeps newest products beyond position 20 reachable on desktop and mobile", () => {
    const newest = Array.from({ length: 28 }, (_, index) => ({ id: index + 1 })) as ProductCardProps[];
    const view = render(<OffersListHomePage icon={<span />} title="جدیدترین ها" products={newest} />);
    for (let page = 0; page < 6; page++) {
      fireEvent.click(screen.getByRole("button", { name: "صفحه بعدی محصولات" }));
    }
    expect(desktopVisibleIds("xl")).toEqual(["25", "26", "27", "28"]);
    expect(renderedProductIds()).toHaveLength(28);
    view.unmount();
    setViewportWidth(390);
    render(<OffersListHomePage icon={<span />} title="جدیدترین ها" products={newest} />);
    expect(renderedProductIds()).toHaveLength(28);
  });

  it("keeps every product in one swipeable track on narrow screens", () => {
    setViewportWidth(390);
    const view = render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="محبوب ترین ها"
        products={products}
      />,
    );

    // The regression this covers: the rail sliced to `productsPerPage`, so a
    // phone had two cards, no overflow, and nothing to swipe.
    expect(renderedProductIds()).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
      "12",
    ]);

    const track = railTrack(view.container);
    expect(track.className).toContain("overflow-x-auto");
    expect(track.className).toContain("snap-x");
    expect(track.className).toContain("snap-mandatory");
    // Desktop keeps the grid, so the scroll track is mobile-only.
    expect(track.className).toContain("lg:grid");
    expect(track.className).toContain("lg:overflow-visible");

    const slide = screen.getAllByTestId("home-product-card")[0].parentElement!;
    expect(slide.className).toContain("shrink-0");
    expect(slide.className).toContain("snap-start");

    expect(mobileViewAllLink()).toHaveAttribute("href", "/plp?sort=AverageRating:desc");
  });

  it("always gives a product rail a mobile view-all destination", () => {
    setViewportWidth(390);
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="جدیدترین ها"
        products={products.slice(0, 1)}
      />,
    );

    expect(mobileViewAllLink()).toHaveAttribute("href", "/offer?type=newest");
  });

  // Custom homepage sections carry an admin-configured target; without it the rail
  // would fall back to the title heuristic and a section named «تخفیف ویژه» would
  // silently link to the discount PLP.
  it("prefers an explicit viewAllHref over the title heuristic on both links", () => {
    setViewportWidth(390);
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="تخفیف ویژه"
        products={products}
        viewAllHref="/plp/category/manto"
      />,
    );

    const links = screen.getAllByRole("link", { name: "مشاهده همه" });
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      expect(link).toHaveAttribute("href", "/plp/category/manto");
    }
    expect(mobileViewAllLink()).toHaveAttribute("href", "/plp/category/manto");
  });

  it("keeps the title heuristic when no viewAllHref is given", () => {
    setViewportWidth(390);
    render(
      <OffersListHomePage
        icon={<span aria-hidden="true" />}
        title="تخفیف ویژه"
        products={products}
      />,
    );

    expect(mobileViewAllLink()).toHaveAttribute("href", "/plp?hasDiscount=true");
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
    expect(desktopVisibleIds("xl")).toEqual(["1", "2", "3", "4"]);
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "transitioning");
    expect(track).toHaveClass("scale-95", "opacity-0");
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("carousel-motion");

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(desktopVisibleIds("xl")).toEqual(["5", "6", "7", "8"]);
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

    expect(desktopVisibleIds("xl")).toEqual(["9", "10", "11", "12"]);
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

    expect(desktopVisibleIds("xl")).toEqual(["5", "6", "7", "8"]);
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
