import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ProductCardProps } from "@/components/Product/Card";
import type { AdaptiveQualitySnapshot } from "@/lib/adaptive-quality";
import DiscountedShowcase from "../DiscountedShowcase";

let mockQuality: AdaptiveQualitySnapshot = {
  enabled: true,
  rendering: "enhanced",
  media: "high",
  motion: "enhanced",
  reducedTransparency: false,
  reason: "promotion",
  routeGeneration: 0,
};
const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => mockQuality,
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

jest.mock("@/components/Product/Card", () => ({
  __esModule: true,
  default: ({ id }: { id: number }) => <div data-testid="discount-product" data-product-id={id} />,
}));

const products = Array.from({ length: 8 }, (_, index) => ({
  id: index + 1,
})) as ProductCardProps[];

describe("DiscountedShowcase adaptive carousel", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockQuality = {
      enabled: true,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reducedTransparency: false,
      reason: "promotion",
      routeGeneration: 0,
    };
    mockNoteEnhancementLoaded.mockClear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn((query: string) => ({
        matches: query === "(min-width: 1280px)",
        media: query,
        onchange: null,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
        addListener: jest.fn(),
        removeListener: jest.fn(),
        dispatchEvent: jest.fn(() => true),
      })),
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("uses the pre-adaptive page transition in Enhanced", () => {
    const { container } = render(<DiscountedShowcase products={products} />);
    const carousel = container.querySelector('[data-aq-carousel="discounted-products"]');

    expect(carousel).toHaveAttribute("data-aq-carousel-motion", "legacy-rich");
    expect(carousel).toHaveAttribute("data-aq-carousel-page", "1");

    fireEvent.click(
      screen.getByRole("button", {
        name: "صفحه بعدی محصولات تخفیف‌دار",
      }),
    );
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "transitioning");
    expect(carousel).toHaveAttribute("data-aq-carousel-page", "1");
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("carousel-motion");

    act(() => {
      jest.advanceTimersByTime(150);
    });
    expect(carousel).toHaveAttribute("data-aq-carousel-page", "2");

    act(() => {
      jest.advanceTimersByTime(50);
    });
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
  });

  it("switches immediately without transition work below Enhanced", () => {
    mockQuality = {
      ...mockQuality,
      rendering: "standard",
      media: "standard",
      motion: "standard",
      reason: "default",
    };
    const { container } = render(<DiscountedShowcase products={products} />);
    const carousel = container.querySelector('[data-aq-carousel="discounted-products"]');
    const baselineTimerCount = jest.getTimerCount();

    fireEvent.click(
      screen.getByRole("button", {
        name: "صفحه بعدی محصولات تخفیف‌دار",
      }),
    );

    expect(carousel).toHaveAttribute("data-aq-carousel-motion", "lightweight");
    expect(carousel).toHaveAttribute("data-aq-carousel-phase", "idle");
    expect(carousel).toHaveAttribute("data-aq-carousel-page", "2");
    expect(mockNoteEnhancementLoaded).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(baselineTimerCount);
  });
});
