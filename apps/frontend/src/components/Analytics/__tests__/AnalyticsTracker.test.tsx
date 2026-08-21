import React from "react";
import { act, render } from "@testing-library/react";

let pathname = "/";
let searchString = "";
let currentUser: { id: number } | null = null;

const track = jest.fn();
const identify = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => pathname,
  useSearchParams: () => new URLSearchParams(searchString),
}));

jest.mock("jotai", () => ({ useAtomValue: () => currentUser }));
jest.mock("@/lib/atoms/auth", () => ({ currentUserAtom: {} }));

jest.mock("next/script", () => ({
  __esModule: true,
  default: function MockScript({
    onLoad,
    ...props
  }: React.ComponentProps<"script"> & { onLoad?: () => void }) {
    React.useEffect(() => onLoad?.(), [onLoad]);
    return <script {...props} />;
  },
}));

import { AnalyticsTracker, normalizeUmamiBaseUrl } from "../AnalyticsTracker";

function pageviewPayloads() {
  return track.mock.calls
    .filter(([input]) => typeof input === "function")
    .map(([factory]) => factory({ website: "site", url: "/default" }));
}

describe("AnalyticsTracker", () => {
  let rafQueue: FrameRequestCallback[];

  beforeEach(() => {
    jest.clearAllMocks();
    pathname = "/";
    searchString = "";
    currentUser = null;
    window.umami = { track, identify } as NonNullable<Window["umami"]>;
    window.localStorage.clear();
    window.sessionStorage.clear();
    process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV = "true";
    process.env.NEXT_PUBLIC_UMAMI_URL = "https://analytics.alpagency.net";
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "123e4567-e89b-42d3-a456-426614174000";
    process.env.NEXT_PUBLIC_RELEASE_SHA = "433e2921";

    rafQueue = [];
    jest.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      rafQueue.push(callback);
      return rafQueue.length;
    });
    jest.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.NEXT_PUBLIC_UMAMI_ENABLE_DEV;
    delete process.env.NEXT_PUBLIC_UMAMI_URL;
    delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    delete process.env.NEXT_PUBLIC_RELEASE_SHA;
    delete window.umami;
  });

  function flushFrames() {
    act(() => rafQueue.splice(0).forEach((callback) => callback(0)));
    act(() => rafQueue.splice(0).forEach((callback) => callback(0)));
  }

  it("emits exactly one manually owned pageview per route", () => {
    document.title = "خانه";
    const { rerender } = render(<AnalyticsTracker />);
    flushFrames();
    expect(pageviewPayloads()).toHaveLength(1);

    rerender(<AnalyticsTracker />);
    flushFrames();
    expect(pageviewPayloads()).toHaveLength(1);

    pathname = "/pdp/red-shirt";
    document.title = "محصول";
    rerender(<AnalyticsTracker />);
    flushFrames();
    expect(pageviewPayloads()).toHaveLength(2);
    expect(pageviewPayloads()[1]).toEqual(expect.objectContaining({ url: "/pdp/red-shirt" }));
  });

  it("does not lose the initial pageview under React Strict Mode", () => {
    const { StrictMode } = React;
    render(
      <StrictMode>
        <AnalyticsTracker />
      </StrictMode>,
    );
    flushFrames();
    expect(pageviewPayloads()).toHaveLength(1);
  });

  it("loads the private tracker with automatic pageviews disabled", () => {
    const { container } = render(<AnalyticsTracker />);
    const script = container.querySelector("script");
    expect(script).toHaveAttribute("src", "https://analytics.alpagency.net/telemetry.js");
    expect(script).toHaveAttribute("data-website-id", "123e4567-e89b-42d3-a456-426614174000");
    expect(script).toHaveAttribute("data-auto-pageview", "false");
    expect(script).not.toHaveAttribute("data-auto-track");
    expect(script).toHaveAttribute("data-performance", "true");
    expect(script).toHaveAttribute("data-tag", "433e2921");
    expect(script).not.toHaveAttribute("data-do-not-track");
  });

  it("re-identifies with the raw internal id after sign in", () => {
    currentUser = { id: 85 };
    render(<AnalyticsTracker />);
    expect(identify).toHaveBeenCalledWith("85");
  });

  it("fails closed when the website configuration is missing", () => {
    delete process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID;
    const { container } = render(<AnalyticsTracker />);
    flushFrames();
    expect(container.querySelector("script")).toBeNull();
    expect(track).not.toHaveBeenCalled();
  });

  it("fails closed for a non-canonical website id or unsafe tracker origin", () => {
    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "website-id";
    const { container, rerender } = render(<AnalyticsTracker />);
    expect(container.querySelector("script")).toBeNull();

    process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID = "123e4567-e89b-42d3-a456-426614174000";
    process.env.NEXT_PUBLIC_UMAMI_URL = "http://analytics.alpagency.net";
    rerender(<AnalyticsTracker />);
    expect(container.querySelector("script")).toBeNull();
  });

  it("allows plain HTTP only for a loopback development collector", () => {
    expect(normalizeUmamiBaseUrl("http://localhost:8093")).toBe("http://localhost:8093");
    expect(normalizeUmamiBaseUrl("http://127.0.0.1:8093")).toBe("http://127.0.0.1:8093");
    expect(normalizeUmamiBaseUrl("http://analytics.alpagency.net")).toBeNull();
  });

  it("tracks route changes from Next navigation hooks without patching browser history", () => {
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;
    const { rerender } = render(<AnalyticsTracker />);
    flushFrames();
    expect(pageviewPayloads()).toHaveLength(1);

    pathname = "/plp";
    searchString = "utm_source=search";
    rerender(<AnalyticsTracker />);
    flushFrames();

    pathname = "/pdp/red-shirt";
    searchString = "";
    rerender(<AnalyticsTracker />);
    flushFrames();

    pathname = "/cart";
    rerender(<AnalyticsTracker />);
    flushFrames();

    expect(pageviewPayloads()).toHaveLength(4);
    expect(pageviewPayloads().map((payload) => payload.url)).toEqual([
      "/",
      "/plp?utm_source=search",
      "/pdp/red-shirt",
      "/cart",
    ]);
    expect(window.history.pushState).toBe(originalPushState);
    expect(window.history.replaceState).toBe(originalReplaceState);
  });
});
