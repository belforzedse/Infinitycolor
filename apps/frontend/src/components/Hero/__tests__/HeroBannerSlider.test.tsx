import { render, screen, waitFor } from "@testing-library/react";
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
    const { container } = render(
      <HeroBannerSlider slides={[slide("one"), slide("two")]} />,
    );

    expect(container.querySelector('[data-aq-hero="static"]')).toBeInTheDocument();
    expect(container.querySelectorAll("picture")).toHaveLength(1);
    expect(container.querySelector("picture")?.closest("a")).toHaveAttribute(
      "href",
      "/plp?hero=one",
    );
  });

  it("uses the native standard slider without mounting rich motion", () => {
    mockHydrated = true;
    const { container } = render(
      <HeroBannerSlider slides={[slide("one"), slide("two")]} />,
    );

    expect(container.querySelector('[data-aq-hero="standard"]')).toBeInTheDocument();
    expect(container.querySelector('[data-aq-hero="enhanced"]')).not.toBeInTheDocument();
    expect(container.querySelectorAll("picture")).toHaveLength(1);
  });

  it("retains the static fallback until the eligible rich chunk resolves", async () => {
    mockHydrated = true;
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
    };
    const { container } = render(
      <HeroBannerSlider slides={[slide("one")]} />,
    );

    expect(container.querySelector('[data-aq-hero="static"]')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("Enhanced hero")).toBeInTheDocument(),
    );
  });

  it("never mounts the rich implementation in Safe or Minimal", async () => {
    mockHydrated = true;
    mockQuality = {
      ...mockQuality,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
    };
    const { container } = render(
      <HeroBannerSlider slides={[slide("one")]} />,
    );

    expect(container.querySelector('[data-aq-hero="static"]')).toBeInTheDocument();
    await Promise.resolve();
    expect(container.querySelector('[data-aq-hero="enhanced"]')).not.toBeInTheDocument();
  });
});
