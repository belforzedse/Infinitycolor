import { renderHook, act } from "@testing-library/react";
import { useMobileStickyHeader } from "../useMobileStickyHeader";

function setViewport({ scrollY, innerWidth }: { scrollY: number; innerWidth: number }) {
  Object.defineProperty(window, "scrollY", { configurable: true, value: scrollY });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: innerWidth });
}

describe("useMobileStickyHeader", () => {
  const originalScrollY = window.scrollY;
  const originalInnerWidth = window.innerWidth;
  const originalRaf = window.requestAnimationFrame;
  const originalCancel = window.cancelAnimationFrame;

  beforeEach(() => {
    window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = jest.fn();
    setViewport({ scrollY: 0, innerWidth: 375 });
  });

  afterEach(() => {
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancel;
    Object.defineProperty(window, "scrollY", { configurable: true, value: originalScrollY });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
  });

  it("does not re-render when scroll stays on the same side of the threshold", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useMobileStickyHeader({ breakpointPx: 1024, scrolledScrollY: 8, nearTopScrollY: 80 });
    });

    expect(result.current.scrolled).toBe(false);
    const rendersAfterMount = renders;

    act(() => {
      setViewport({ scrollY: 3, innerWidth: 375 });
      window.dispatchEvent(new Event("scroll"));
    });

    expect(renders).toBe(rendersAfterMount);
    expect(result.current.scrolled).toBe(false);
    expect(result.current.showHeader).toBe(true);
  });

  it("updates scrolled once when crossing the threshold", () => {
    const { result } = renderHook(() =>
      useMobileStickyHeader({ breakpointPx: 1024, scrolledScrollY: 8 }),
    );

    act(() => {
      setViewport({ scrollY: 12, innerWidth: 375 });
      window.dispatchEvent(new Event("scroll"));
    });

    expect(result.current.scrolled).toBe(true);
  });
});
