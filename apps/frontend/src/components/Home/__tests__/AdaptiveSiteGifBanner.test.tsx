import { render } from "@testing-library/react";
import AdaptiveSiteGifBanner from "../AdaptiveSiteGifBanner";

const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

describe("AdaptiveSiteGifBanner", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders the animated GIF source immediately without a quality shell", () => {
    const { container } = render(
      <AdaptiveSiteGifBanner enabled imageUrl="/uploads/campaign.gif" altText="پیشنهاد ویژه" />,
    );

    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("/uploads/campaign.gif"),
    );
    expect(container.querySelector("[data-aq-optional-media='gif-shell']")).toBeNull();
    expect(mockNoteEnhancementLoaded).toHaveBeenCalledWith("optional-gif");
  });

  it("still renders nothing when the GIF is disabled", () => {
    const { container } = render(
      <AdaptiveSiteGifBanner enabled={false} imageUrl="/uploads/campaign.gif" />,
    );

    expect(container.firstChild).toBeNull();
    expect(mockNoteEnhancementLoaded).not.toHaveBeenCalled();
  });
});
