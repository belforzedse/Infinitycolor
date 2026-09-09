import { render } from "@testing-library/react";
import AboutBanners from "../AboutBanners";
import { ABOUT_PRICE_BANNERS } from "../aboutBanners";

describe("AboutBanners", () => {
  it("renders two equal lifestyle banners side by side", () => {
    const { container } = render(<AboutBanners />);
    const images = container.querySelectorAll("img");

    expect(ABOUT_PRICE_BANNERS).toHaveLength(2);
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute("alt", "");
    expect(images[1]).toHaveAttribute("alt", "");
    expect(decodeURIComponent(images[0]?.getAttribute("src") || "")).toContain(
      "/images/about/banner-right.jpg",
    );
    expect(decodeURIComponent(images[1]?.getAttribute("src") || "")).toContain(
      "/images/about/banner-left.jpg",
    );

    const frames = Array.from(container.querySelectorAll("div")).filter((el) =>
      el.className.includes("aspect-[1024/542]"),
    );
    expect(frames).toHaveLength(2);
    frames.forEach((frame) => {
      expect(frame).toHaveClass("rounded-2xl");
    });
  });
});
