import { fireEvent, render, screen } from "@testing-library/react";
import ThumbnailList from "../ThumbnailList";
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

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => mockQuality,
}));

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    fill: _fill,
    loader: _loader,
    placeholder: _placeholder,
    blurDataURL: _blurDataURL,
    ...props
  }: React.ComponentProps<"img"> & {
    fill?: boolean;
    loader?: unknown;
    placeholder?: string;
    blurDataURL?: string;
  }) => <span role="img" aria-label={props.alt} />,
}));

const assets = [
  {
    id: "cover",
    type: "image" as const,
    src: "/media/cover-large.jpg",
    thumbnail: "/media/cover-thumb.jpg",
    alt: "تصویر روی محصول",
  },
  {
    id: "detail",
    type: "image" as const,
    src: "/media/detail-large.jpg",
    thumbnail: "/media/detail-thumb.jpg",
    alt: "جزئیات محصول",
  },
];

describe("PDP gallery thumbnails", () => {
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
  const originalRequestAnimationFrame = window.requestAnimationFrame;

  beforeEach(() => {
    mockQuality = {
      enabled: true,
      rendering: "safe",
      media: "economy",
      motion: "minimal",
      reducedTransparency: false,
      reason: "forced-safe",
      routeGeneration: 0,
    };
    HTMLElement.prototype.scrollIntoView = jest.fn();
    window.requestAnimationFrame = (callback) => {
      callback(0);
      return 1;
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    window.requestAnimationFrame = originalRequestAnimationFrame;
  });

  it("uses semantic selected buttons and keeps Economy hover non-speculative", () => {
    const imageConstructor = jest.spyOn(window, "Image");
    const setSelectedImage = jest.fn();
    const { rerender } = render(
      <ThumbnailList assets={assets} selectedImage="cover" setSelectedImage={setSelectedImage} />,
    );

    const cover = screen.getByRole("button", {
      name: "نمایش تصویر 1: تصویر روی محصول",
    });
    const detail = screen.getByRole("button", {
      name: "نمایش تصویر 2: جزئیات محصول",
    });
    expect(cover).toHaveAttribute("aria-pressed", "true");
    expect(detail).toHaveAttribute("aria-pressed", "false");
    fireEvent.mouseEnter(detail);
    expect(imageConstructor).not.toHaveBeenCalled();
    fireEvent.click(detail);
    expect(setSelectedImage).toHaveBeenCalledWith("detail");

    mockQuality = {
      ...mockQuality,
      rendering: "enhanced",
      media: "high",
      motion: "enhanced",
      reason: "promotion",
    };
    rerender(
      <ThumbnailList assets={assets} selectedImage="cover" setSelectedImage={setSelectedImage} />,
    );
    fireEvent.mouseEnter(
      screen.getByRole("button", {
        name: "نمایش تصویر 2: جزئیات محصول",
      }),
    );
    expect(imageConstructor).toHaveBeenCalledTimes(1);
  });
  it("scrolls the thumbnail container without scrolling the page", () => {
    const setSelectedImage = jest.fn();

    const { rerender } = render(
      <ThumbnailList assets={assets} selectedImage="cover" setSelectedImage={setSelectedImage} />,
    );

    const container = screen.getByTestId("pdp-thumbnails");
    const target = screen.getByRole("button", {
      name: "نمایش تصویر 2: جزئیات محصول",
    });

    const scrollBy = jest.fn();

    Object.defineProperties(container, {
      clientWidth: { configurable: true, value: 120 },
      clientHeight: { configurable: true, value: 120 },
      scrollWidth: { configurable: true, value: 120 },
      scrollHeight: { configurable: true, value: 400 },
      scrollBy: { configurable: true, value: scrollBy },
    });

    jest.spyOn(container, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 120, 120));

    jest.spyOn(target, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 240, 84, 105));

    rerender(
      <ThumbnailList assets={assets} selectedImage="detail" setSelectedImage={setSelectedImage} />,
    );

    expect(scrollBy).toHaveBeenCalledWith({
      left: 0,
      top: 225,
      behavior: "auto",
    });

    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });
});
