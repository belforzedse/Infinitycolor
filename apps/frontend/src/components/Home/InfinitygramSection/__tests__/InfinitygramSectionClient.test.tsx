import { render } from "@testing-library/react";
import type { SocialFeedPost } from "@repo/social-posts";
import InfinitygramSectionClient from "../InfinitygramSectionClient";
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

const COVER = "data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=";

const posts: SocialFeedPost[] = [
  {
    id: "xl-video",
    slug: "xl-video",
    title: "XL video",
    desktopVariant: "xl",
    imageSrc: COVER,
    imageAlt: "XL cover",
    previewMedia: {
      id: "xl-video-preview",
      url: "/media/xl-video.mp4",
      alternativeText: "XL video",
      mime: "video/mp4",
    },
    media: [],
    likesCount: 12,
    commentsCount: 3,
    overlay: "video",
  },
  {
    id: "small-image",
    slug: "small-image",
    title: "Small image",
    desktopVariant: "sm",
    imageSrc: COVER,
    imageAlt: "Small cover",
    previewMedia: {
      id: "small-image-preview",
      url: COVER,
      alternativeText: "Small image",
      mime: "image/gif",
    },
    media: [],
    likesCount: 4,
    commentsCount: 1,
    overlay: null,
  },
];

describe("InfinitygramSectionClient static parity", () => {
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
  });

  it("keeps the real cards, variants, images, and grid in Economy", () => {
    const { container } = render(<InfinitygramSectionClient posts={posts} />);

    const grid = container.querySelector('[data-aq-infinitygram-layout="shared"]');
    expect(grid).toHaveAttribute("data-aq-infinitygram-media", "static");
    expect(grid?.querySelectorAll("article")).toHaveLength(2);
    expect(grid?.querySelectorAll('[data-variant="xl"]')).toHaveLength(1);
    expect(grid?.querySelectorAll('[data-variant="sm"]')).toHaveLength(1);
    expect(grid?.querySelectorAll("img").length).toBeGreaterThanOrEqual(2);
    expect(grid?.querySelectorAll("video")).toHaveLength(0);
    expect(grid?.querySelectorAll('[data-social-post-media="static"]')).toHaveLength(2);
    expect(grid?.querySelector("img.img-fx")).not.toBeInTheDocument();
  });

  it("changes only moving-media attachment above Economy", () => {
    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reason: "promotion",
    };
    const { container } = render(<InfinitygramSectionClient posts={posts} />);

    const grid = container.querySelector('[data-aq-infinitygram-layout="shared"]');
    expect(grid).toHaveAttribute("data-aq-infinitygram-media", "rich");
    expect(grid?.querySelectorAll("article")).toHaveLength(2);
    expect(grid?.querySelector('video[src="/media/xl-video.mp4"]')).toBeInTheDocument();
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("social-media");
  });
});
