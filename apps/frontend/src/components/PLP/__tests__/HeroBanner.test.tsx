import { fireEvent, render, screen } from "@testing-library/react";
import PLPHeroBanner from "../HeroBanner";
import {
  getPlpHeroSwipeDelta,
  PLP_HERO_SLIDES,
  PLP_HERO_SWIPE_THRESHOLD_PX,
} from "../plpHeroSlides";
import { scrollIntoViewWithOffset } from "@/utils/scroll";

jest.mock("@/utils/scroll", () => ({
  scrollIntoViewWithOffset: jest.fn(),
}));

const mockedScroll = scrollIntoViewWithOffset as jest.MockedFunction<typeof scrollIntoViewWithOffset>;

describe("getPlpHeroSwipeDelta", () => {
  it("advances on a left swipe and ignores small movement", () => {
    expect(getPlpHeroSwipeDelta(-(PLP_HERO_SWIPE_THRESHOLD_PX + 1))).toBe(1);
    expect(getPlpHeroSwipeDelta(PLP_HERO_SWIPE_THRESHOLD_PX + 1)).toBe(-1);
    expect(getPlpHeroSwipeDelta(PLP_HERO_SWIPE_THRESHOLD_PX - 1)).toBe(0);
  });
});

describe("PLPHeroBanner", () => {
  beforeEach(() => {
    mockedScroll.mockClear();
    document.body.replaceChildren();
  });

  it("renders three art-directed slides that fill the PLP hero frame", () => {
    const { container } = render(<PLPHeroBanner />);

    const frame = screen.getByRole("button", { name: "مشاهده محصولات" });
    expect(frame).toHaveClass("aspect-[414/130]", "md:aspect-[1360/400]");

    const pictures = container.querySelectorAll("picture");
    expect(pictures).toHaveLength(PLP_HERO_SLIDES.length);

    PLP_HERO_SLIDES.forEach((slide, index) => {
      const picture = pictures[index];
      expect(picture?.querySelector("source")?.getAttribute("srcset")).toBe(slide.mobileSrc);
      expect(picture?.querySelector("img")).toHaveAttribute("src", slide.desktopSrc);
      expect(picture?.querySelector("img")).toHaveClass("object-cover");
    });

    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.getByRole("tab", { name: "اسلاید ۱" })).toHaveAttribute("aria-selected", "true");
  });

  it("scrolls to the product list when the banner is clicked", () => {
    const products = document.createElement("div");
    products.id = "plp-products";
    document.body.appendChild(products);

    render(<PLPHeroBanner />);
    fireEvent.click(screen.getByRole("button", { name: "مشاهده محصولات" }));

    expect(mockedScroll).toHaveBeenCalledTimes(1);
    expect(mockedScroll).toHaveBeenCalledWith(products);
  });

  it("changes slide from pagination dots without scrolling to products", () => {
    render(<PLPHeroBanner />);

    fireEvent.click(screen.getByRole("tab", { name: "اسلاید ۲" }));

    expect(screen.getByRole("tab", { name: "اسلاید ۲" })).toHaveAttribute("aria-selected", "true");
    expect(mockedScroll).not.toHaveBeenCalled();
  });

  it("moves to the next slide with the arrow key without scrolling", () => {
    render(<PLPHeroBanner />);
    fireEvent.keyDown(screen.getByRole("button", { name: "مشاهده محصولات" }), {
      key: "ArrowLeft",
    });

    expect(screen.getByRole("tab", { name: "اسلاید ۲" })).toHaveAttribute("aria-selected", "true");
    expect(mockedScroll).not.toHaveBeenCalled();
  });
});
