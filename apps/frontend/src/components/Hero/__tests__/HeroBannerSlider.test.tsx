import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import HeroBannerSlider from "../HeroBannerSlider";
import type { HeroSlideConfig } from "@/types/super-admin/heroSliderV3";
import type { AdaptiveQualitySnapshot } from "@/lib/adaptive-quality";

let mockHydrated = false;
let mockQuality: AdaptiveQualitySnapshot = {
  enabled: true,
  rendering: "standard",
  media: "standard",
  motion: "standard",
  reducedTransparency: false,
  reason: "default",
  routeGeneration: 0,
};

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveHydrated: () => mockHydrated,
  useAdaptiveQuality: () => mockQuality,
}));

jest.mock("../HeroEnhancedSlider", () => ({
  __esModule: true,
  default: () => <div data-aq-hero="enhanced">Enhanced hero</div>,
}));

const slide = (id: string): HeroSlideConfig => ({
  id,
  imageUrl: `/images/${id}-desktop.webp`,
  imageAlt: `Desktop ${id}`,
  mobileImageUrl: `/images/${id}-mobile.webp`,
  mobileImageAlt: `Mobile ${id}`,
  link: { type: "internal", href: `/plp?hero=${id}` },
  isActive: true,
  autoplayEligible: true,
  order: 0,
  schedule: { timezone: "Asia/Tehran" },
  tracking: {
    campaign: "",
    source: "",
    medium: "",
    content: "",
    custom: {},
  },
});

describe("HeroBannerSlider adaptive gate", () => {
  beforeEach(() => {
    mockHydrated = false;
    mockQuality = {
      enabled: true,
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
  });

  it("keeps one linked responsive LCP image for SSR and first hydration", () => {
    const { container } = render(<HeroBannerSlider slides={[slide("one"), slide("two")]} />);

    expect(container.querySelector('[data-aq-hero="static"]')).toBeInTheDocument();
    expect(container.querySelectorAll("picture")).toHaveLength(1);
    expect(container.querySelector("picture")?.closest("a")).toHaveAttribute(
      "href",
      "/plp?hero=one",
    );
  });

  it("uses the native standard slider without mounting rich motion", () => {
    mockHydrated = true;
    const { container } = render(<HeroBannerSlider slides={[slide("one"), slide("two")]} />);

    expect(container.querySelector('[data-aq-hero="standard"]')).toBeInTheDocument();
    expect(container.querySelector('[data-aq-hero="enhanced"]')).not.toBeInTheDocument();
    expect(container.querySelectorAll("picture")).toHaveLength(1);
  });

  it("retains the complete standard slider until the eligible rich chunk resolves", async () => {
    mockHydrated = true;
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    };
    const { container } = render(<HeroBannerSlider slides={[slide("one")]} />);

    expect(container.querySelector('[data-aq-hero="standard"]')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Enhanced hero")).toBeInTheDocument());
  });

  it("places pagination below the mobile banner instead of overlaying slide content", () => {
    mockHydrated = true;
    const { container } = render(<HeroBannerSlider slides={[slide("one"), slide("two")]} />);

    const banner = container.querySelector("[data-hero-banner]");
    const pagination = container.querySelector("[data-hero-pagination]");
    const slideButton = screen.getByRole("button", { name: "Go to slide 2" });

    expect(banner).toBeInTheDocument();
    expect(pagination).toBeInTheDocument();
    expect(banner?.contains(slideButton)).toBe(false);
    expect(pagination?.contains(slideButton)).toBe(true);
  });

  it("keeps every slide and manual control available in Safe or Minimal", async () => {
    mockHydrated = true;
    mockQuality = {
      ...mockQuality,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    };
    const { container } = render(<HeroBannerSlider slides={[slide("one"), slide("two")]} />);

    expect(container.querySelector('[data-aq-hero="standard"]')).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Go to slide 2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Go to slide 2" }));
    expect(container.querySelector('a[href="/plp?hero=two"]')).toBeInTheDocument();
    await Promise.resolve();
    expect(container.querySelector('[data-aq-hero="enhanced"]')).not.toBeInTheDocument();
  });
});

describe("HeroBannerSlider autoplay", () => {
  const activeSlideHref = (container: HTMLElement) =>
    container.querySelector("a[href^='/plp?hero=']")?.getAttribute("href");

  beforeEach(() => {
    jest.useFakeTimers();
    mockHydrated = true;
    mockQuality = {
      enabled: true,
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reducedTransparency: false,
      reason: "default",
      routeGeneration: 0,
    };
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("advances the standard hero every four seconds and loops past the last slide", () => {
    const { container } = render(
      <HeroBannerSlider slides={[slide("one"), slide("two"), slide("three")]} />,
    );

    expect(activeSlideHref(container)).toBe("/plp?hero=one");

    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(activeSlideHref(container)).toBe("/plp?hero=two");

    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(activeSlideHref(container)).toBe("/plp?hero=three");

    // Looping back to the first slide, not stopping at the end.
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(activeSlideHref(container)).toBe("/plp?hero=one");
  });

  it("restarts the interval after a manual change instead of double-advancing", () => {
    const { container } = render(
      <HeroBannerSlider slides={[slide("one"), slide("two"), slide("three")]} />,
    );

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Go to slide 3" }));
    expect(activeSlideHref(container)).toBe("/plp?hero=three");

    // The 1000ms left on the pre-click timer must not fire: were it still
    // running, the slide would move again right after the click.
    act(() => {
      jest.advanceTimersByTime(3999);
    });
    expect(activeSlideHref(container)).toBe("/plp?hero=three");

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(activeSlideHref(container)).toBe("/plp?hero=one");
  });

  it("runs no autoplay timer for a single-slide hero", () => {
    const single = render(<HeroBannerSlider slides={[slide("only")]} />);
    const singleSlideTimers = jest.getTimerCount();
    single.unmount();

    const many = render(
      <HeroBannerSlider slides={[slide("one"), slide("two")]} />,
    );

    // Measured as a difference rather than an absolute count: the environment
    // keeps a timer of its own, and what matters is that a lone slide adds no
    // interval on top of it.
    expect(jest.getTimerCount()).toBe(singleSlideTimers + 1);
    many.unmount();
  });

  it("clears its interval on unmount", () => {
    const view = render(<HeroBannerSlider slides={[slide("one"), slide("two")]} />);

    expect(jest.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
