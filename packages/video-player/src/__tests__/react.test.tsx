import { act, render } from "@testing-library/react";
import { useRef } from "react";
import { liveEngineCounts } from "../engine";
import { InlineVideo } from "../react/InlineVideo";
import { useVisibilitySlot, type VisibilitySlot } from "../react/useVisibilitySlot";
import { controlMedia, installMediaStub, uninstallMediaStub } from "./media-stub";

const SOURCE = {
  mp4: "https://cdn.test/uploads/a_v1-0a1b2c3d.mp4",
  poster: "https://cdn.test/uploads/a_v1-0a1b2c3d.jpg",
};

beforeEach(() => installMediaStub());
afterEach(() => uninstallMediaStub());

describe("InlineVideo", () => {
  function renderVideo(props: Partial<React.ComponentProps<typeof InlineVideo>> = {}) {
    const view = render(
      <InlineVideo source={SOURCE} active={false} playing={false} muted surface="post-detail" {...props} />,
    );
    const video = view.container.querySelector("video")!;
    const poster = view.container.querySelector("img")!;
    return { view, video, poster, media: controlMedia(video) };
  }

  it("is only a poster while inactive: no source, no requests, no decoder", () => {
    const { video, poster } = renderVideo();
    expect(video.getAttribute("src")).toBeNull();
    expect(poster).toHaveStyle({ opacity: "1" });
    expect(liveEngineCounts().engines).toBe(0);
  });

  it("attaches and plays when active, keeping the poster up until a real frame", async () => {
    const { view, video, poster, media } = renderVideo();
    view.rerender(<InlineVideo source={SOURCE} active playing muted surface="post-detail" />);
    expect(video.src).toBe(SOURCE.mp4);
    expect(media.playCalls()).toBe(1);
    await act(() => media.resolvePlay());
    expect(poster).toHaveStyle({ opacity: "1" });
    act(() => {
      media.set({ readyState: 4, currentTime: 0.05 });
      media.emit("timeupdate");
    });
    expect(poster).toHaveStyle({ opacity: "0" });
  });

  it("pauses when it stops being the playing item and releases everything on deactivation", async () => {
    const { view, video, media } = renderVideo({ active: true, playing: true });
    await act(() => media.resolvePlay());
    view.rerender(<InlineVideo source={SOURCE} active playing={false} muted surface="post-detail" />);
    expect(media.state().paused).toBe(true);
    view.rerender(<InlineVideo source={SOURCE} active={false} playing={false} muted surface="post-detail" />);
    expect(video.getAttribute("src")).toBeNull();
    expect(liveEngineCounts().engines).toBe(0);
  });

  it("unmount releases the element even mid-playback", async () => {
    const { view, video, media } = renderVideo({ active: true, playing: true });
    await act(() => media.resolvePlay());
    view.unmount();
    expect(video.getAttribute("src")).toBeNull();
    expect(liveEngineCounts().engines).toBe(0);
  });

  it("surfaces a refused autoplay so the surface can offer tap-to-play", async () => {
    const seen: string[] = [];
    const { media } = renderVideo({
      active: true,
      playing: true,
      children: (state) => {
        seen.push(String(state.failure));
        return null;
      },
    });
    await act(() => media.rejectPlay("NotAllowedError"));
    expect(seen.at(-1)).toBe("autoplay-denied");
  });
});

describe("useVisibilitySlot", () => {
  type Callback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
  const observers: Array<{ callback: Callback; options?: IntersectionObserverInit; targets: Element[] }> = [];

  beforeEach(() => {
    observers.length = 0;
    (window as any).IntersectionObserver = class {
      targets: Element[] = [];
      constructor(public callback: Callback, public options?: IntersectionObserverInit) {
        observers.push(this as any);
      }
      observe(target: Element) {
        this.targets.push(target);
      }
      unobserve(target: Element) {
        this.targets = this.targets.filter((entry) => entry !== target);
      }
      disconnect() {
        this.targets = [];
      }
    };
  });

  afterEach(() => {
    delete (window as any).IntersectionObserver;
  });

  function Probe({ id, onSlot }: { id: string; onSlot: (id: string, slot: VisibilitySlot) => void }) {
    const ref = useRef<HTMLDivElement>(null);
    const slot = useVisibilitySlot(ref);
    onSlot(id, slot);
    return <div ref={ref} data-id={id} />;
  }

  function report(target: Element, ratio: number, near = ratio > 0) {
    const [visible, nearObserver] = observers;
    act(() => {
      visible.callback([{ target, isIntersecting: ratio > 0, intersectionRatio: ratio }]);
      nearObserver.callback([{ target, isIntersecting: near, intersectionRatio: near ? 1 : 0 }]);
    });
  }

  it("makes exactly one element active — the most visible above threshold", () => {
    const slots = new Map<string, VisibilitySlot>();
    const { container } = render(
      <>
        <Probe id="a" onSlot={(id, slot) => slots.set(id, slot)} />
        <Probe id="b" onSlot={(id, slot) => slots.set(id, slot)} />
        <Probe id="c" onSlot={(id, slot) => slots.set(id, slot)} />
      </>,
    );
    const [a, b, c] = Array.from(container.querySelectorAll("[data-id]"));
    report(a, 0.7);
    report(b, 0.95);
    report(c, 0, true);
    expect(Object.fromEntries(slots)).toEqual({ a: "near", b: "active", c: "near" });

    report(b, 0.3);
    expect(Object.fromEntries(slots)).toEqual({ a: "active", b: "near", c: "near" });
  });

  it("goes idle everywhere while the tab is hidden, and resumes when it returns", () => {
    const slots = new Map<string, VisibilitySlot>();
    const { container } = render(<Probe id="a" onSlot={(id, slot) => slots.set(id, slot)} />);
    report(container.querySelector("[data-id]")!, 1);
    expect(slots.get("a")).toBe("active");

    const visibility = jest.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(slots.get("a")).toBe("idle");
    visibility.mockReturnValue("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(slots.get("a")).toBe("active");
    visibility.mockRestore();
  });
});
