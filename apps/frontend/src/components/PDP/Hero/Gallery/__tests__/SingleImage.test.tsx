import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import SingleImage from "../SingleImage";
import type { AdaptiveQualitySnapshot } from "@/lib/adaptive-quality";

let mockQuality: AdaptiveQualitySnapshot = {
  enabled: true,
  rendering: "safe",
  media: "economy",
  motion: "minimal",
  reducedTransparency: false,
  reason: "forced-safe",
  routeGeneration: 0,
};

const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => mockQuality,
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

jest.mock("@use-gesture/react", () => ({
  useDrag: () => () => ({}),
}));

jest.mock("@/utils/haptics", () => ({
  hapticNavigation: jest.fn(),
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    loader: _loader,
    priority: _priority,
    quality: _quality,
    ...props
  }: React.ComponentProps<"img"> & {
    fill?: boolean;
    loader?: unknown;
    priority?: boolean;
    quality?: number;
  }) => <span role="img" aria-label={props.alt} />,
}));

const navigationProps = {
  goToNextImage: jest.fn(),
  goToPreviousImage: jest.fn(),
};

describe("PDP gallery active medium", () => {
  const originalPlay = HTMLMediaElement.prototype.play;

  beforeEach(() => {
    mockNoteEnhancementLoaded.mockClear();
    mockQuality = {
      enabled: true,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reducedTransparency: false,
      reason: "forced-safe",
      routeGeneration: 0,
    };
    HTMLMediaElement.prototype.play = jest.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    HTMLMediaElement.prototype.play = originalPlay;
  });

  it("keeps image zoom available and uses a static low-cost placeholder", () => {
    const { container } = render(
      <SingleImage
        type="image"
        src="/media/product.jpg"
        thumb="/media/product-thumb.jpg"
        alt="محصول"
        {...navigationProps}
      />,
    );

    expect(container.querySelector('[data-aq-pdp-zoom="available"]')).toBeInTheDocument();
    expect(container.querySelector('[data-aq-pdp-placeholder="static"]')).toBeInTheDocument();
  });

  it("attaches Economy video only after play and preserves user-started media on downgrade", async () => {
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reason: "promotion",
    };
    const { container, rerender } = render(
      <SingleImage
        type="video"
        src="/media/product.mp4"
        thumb="/media/product-poster.jpg"
        alt="ویدیوی محصول"
        {...navigationProps}
      />,
    );

    const video = container.querySelector("video");
    expect(video).not.toHaveAttribute("src");
    fireEvent.click(screen.getByRole("button", { name: "Play video" }));
    await waitFor(() => expect(video).toHaveAttribute("src", "/media/product.mp4"));
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("optional-video");

    mockQuality = {
      ...mockQuality,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reason: "repeated-long-task",
    };
    rerender(
      <SingleImage
        type="video"
        src="/media/product.mp4"
        thumb="/media/product-poster.jpg"
        alt="ویدیوی محصول"
        {...navigationProps}
      />,
    );
    expect(video).toHaveAttribute("src", "/media/product.mp4");
  });
});
