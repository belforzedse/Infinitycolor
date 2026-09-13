import { act, fireEvent, render, screen } from "@testing-library/react";
import PLPHeroBanner from "../HeroBanner";
import {
  clampPlpHeroIndex,
  getPlpHeroSwipeDelta,
  PLP_HERO_SLIDES,
  PLP_HERO_SWIPE_FLICK_VELOCITY,
  PLP_HERO_SWIPE_THRESHOLD_PX,
} from "../plpHeroSlides";
import { scrollIntoViewWithOffset } from "@/utils/scroll";

jest.mock("@/utils/scroll", () => ({
  scrollIntoViewWithOffset: jest.fn(),
}));

const mockedScroll = scrollIntoViewWithOffset as jest.MockedFunction<typeof scrollIntoViewWithOffset>;

function swipePointer(
  target: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const fire = (type: string, x: number, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, {
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: x,
      clientY: y,
    });
    target.dispatchEvent(event);
  };

  act(() => {
    fire("pointerdown", from.x, from.y);
    fire("pointermove", to.x, to.y);
    fire("pointerup", to.x, to.y);
  });
}

describe("getPlpHeroSwipeDelta", () => {
  it("advances on a left swipe and ignores small movement", () => {
    expect(getPlpHeroSwipeDelta(-(PLP_HERO_SWIPE_THRESHOLD_PX + 1))).toBe(1);
    expect(getPlpHeroSwipeDelta(PLP_HERO_SWIPE_THRESHOLD_PX + 1)).toBe(-1);
    expect(getPlpHeroSwipeDelta(PLP_HERO_SWIPE_THRESHOLD_PX - 1)).toBe(0);
  });

  it("accepts a short flick when velocity is high", () => {
    expect(getPlpHeroSwipeDelta(-16, PLP_HERO_SWIPE_THRESHOLD_PX, PLP_HERO_SWIPE_FLICK_VELOCITY)).toBe(
      1,
    );
    expect(getPlpHeroSwipeDelta(16, PLP_HERO_SWIPE_THRESHOLD_PX, PLP_HERO_SWIPE_FLICK_VELOCITY)).toBe(
      -1,
    );
  });
});

describe("clampPlpHeroIndex", () => {
  it("stops at the first and last slide instead of wrapping", () => {
    expect(clampPlpHeroIndex(-1)).toBe(0);
    expect(clampPlpHeroIndex(PLP_HERO_SLIDES.length + 2)).toBe(PLP_HERO_SLIDES.length - 1);
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

  it("follows a horizontal swipe onto the next slide without scrolling to products", () => {
    render(<PLPHeroBanner />);
    const frame = screen.getByRole("button", { name: "مشاهده محصولات" });
    Object.defineProperty(frame, "offsetWidth", { configurable: true, value: 400 });

    swipePointer(frame, { x: 280, y: 40 }, { x: 80, y: 42 });

    expect(screen.getByRole("tab", { name: "اسلاید ۲" })).toHaveAttribute("aria-selected", "true");
    expect(mockedScroll).not.toHaveBeenCalled();
  });

  it("keeps the current slide when the gesture is vertical scrolling", () => {
    render(<PLPHeroBanner />);
    const frame = screen.getByRole("button", { name: "مشاهده محصولات" });

    swipePointer(frame, { x: 200, y: 16 }, { x: 204, y: 90 });

    expect(screen.getByRole("tab", { name: "اسلاید ۱" })).toHaveAttribute("aria-selected", "true");
  });
});

describe("PLPHeroBanner autoplay", () => {
  const selectedSlide = () =>
    screen
      .getAllByRole("tab")
      .findIndex((tab) => tab.getAttribute("aria-selected") === "true");

  beforeEach(() => {
    jest.useFakeTimers();
    mockedScroll.mockClear();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it("advances every four seconds and wraps from the last slide to the first", () => {
    render(<PLPHeroBanner />);
    expect(selectedSlide()).toBe(0);

    for (let step = 1; step < PLP_HERO_SLIDES.length; step += 1) {
      act(() => {
        jest.advanceTimersByTime(4000);
      });
      expect(selectedSlide()).toBe(step);
    }

    // The swipe path clamps at the end; autoplay and the dots wrap.
    act(() => {
      jest.advanceTimersByTime(4000);
    });
    expect(selectedSlide()).toBe(0);
  });

  it("restarts the interval after a swipe instead of double-advancing", () => {
    render(<PLPHeroBanner />);
    const frame = screen.getByRole("button", { name: "مشاهده محصولات" });
    Object.defineProperty(frame, "offsetWidth", { configurable: true, value: 400 });

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    swipePointer(frame, { x: 280, y: 40 }, { x: 80, y: 42 });
    expect(selectedSlide()).toBe(1);

    act(() => {
      jest.advanceTimersByTime(3999);
    });
    expect(selectedSlide()).toBe(1);

    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(selectedSlide()).toBe(2);
  });

  it("restarts the interval after a dot click", () => {
    render(<PLPHeroBanner />);

    act(() => {
      jest.advanceTimersByTime(3000);
    });
    fireEvent.click(screen.getByRole("tab", { name: "اسلاید ۳" }));
    expect(selectedSlide()).toBe(2);

    act(() => {
      jest.advanceTimersByTime(3999);
    });
    expect(selectedSlide()).toBe(2);
  });

  it("clears its interval on unmount", () => {
    const view = render(<PLPHeroBanner />);
    const mounted = jest.getTimerCount();
    expect(mounted).toBeGreaterThan(0);

    view.unmount();
    expect(jest.getTimerCount()).toBeLessThan(mounted);
  });
});
