import { act, render, screen, waitFor } from "@testing-library/react";
import * as Sentry from "@sentry/nextjs";
import SuspenseLoader from "../SuspenseLoader";

jest.mock("@sentry/nextjs", () => ({ captureException: jest.fn() }));
let mockAnimationCrash = false;
const mockPlayerListeners = new Map<string, () => void>();
const mockPlayer = {
  isLoaded: false,
  stop: jest.fn(),
  destroy: jest.fn(),
  addEventListener: jest.fn((type: string, listener: () => void) =>
    mockPlayerListeners.set(type, listener),
  ),
  removeEventListener: jest.fn((type: string) => mockPlayerListeners.delete(type)),
};
jest.mock("@lottiefiles/dotlottie-react", () => ({
  DotLottieReact: function MockAnimation({
    dotLottieRefCallback,
  }: {
    dotLottieRefCallback: (instance: unknown) => void;
  }) {
    const React = jest.requireActual("react");
    React.useEffect(() => {
      dotLottieRefCallback(mockPlayer);
      return () => {
        mockPlayer.destroy();
        dotLottieRefCallback(null);
      };
    }, [dotLottieRefCallback]);
    if (mockAnimationCrash)
      throw new Error(
        "recursive use of an object detected which would lead to unsafe aliasing in rust",
      );
    return React.createElement("canvas", { "data-testid": "loader-animation" });
  },
}));

let mockHydrated = true;
let mockQuality: {
  rendering: "safe" | "standard" | "enhanced";
  motion: "minimal" | "standard" | "enhanced";
} = {
  rendering: "safe",
  motion: "minimal",
};
const mockNoteEnhancementLoaded = jest.fn();

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveHydrated: () => mockHydrated,
  useAdaptiveQuality: () => mockQuality,
  noteEnhancementLoaded: (...args: unknown[]) => mockNoteEnhancementLoaded(...args),
}));

describe("SuspenseLoader adaptive gate", () => {
  beforeEach(() => {
    mockHydrated = true;
    mockQuality = { rendering: "safe", motion: "minimal" };
    mockNoteEnhancementLoaded.mockClear();
    mockAnimationCrash = false;
    mockPlayer.isLoaded = false;
    mockPlayerListeners.clear();
    mockPlayer.stop.mockClear();
    mockPlayer.destroy.mockClear();
    jest.mocked(Sentry.captureException).mockClear();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    global.fetch = jest.fn();
  });

  it("uses the CSS fallback without fetching Lottie in Safe", () => {
    const { container } = render(<SuspenseLoader fullscreen={false} />);

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(mockNoteEnhancementLoaded).not.toHaveBeenCalled();
  });

  it("keeps the CSS fallback on the first hydration render", () => {
    mockHydrated = false;
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    const { container } = render(<SuspenseLoader fullscreen={false} />);

    expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps the fallback until the player loads and lets the wrapper own teardown", async () => {
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    jest
      .mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => ({ v: "5.7", layers: [] }) } as Response);
    const { container, rerender } = render(<SuspenseLoader fullscreen={false} />);
    await screen.findByTestId("loader-animation");
    const fallback = container.querySelector(".animate-spin")!.parentElement!;
    expect(fallback).toHaveClass("opacity-100");
    act(() => mockPlayerListeners.get("load")?.());
    await waitFor(() => expect(fallback).toHaveClass("opacity-0"));
    mockQuality = { rendering: "safe", motion: "minimal" };
    rerender(<SuspenseLoader fullscreen={false} />);
    expect(screen.queryByTestId("loader-animation")).not.toBeInTheDocument();
    expect(fallback).toHaveClass("opacity-100");
    expect(mockPlayer.destroy).toHaveBeenCalledTimes(1);
    expect(mockPlayer.stop).not.toHaveBeenCalled();
    expect(mockPlayerListeners.size).toBe(0);
  });

  it("contains a player crash and preserves the same CSS loader", async () => {
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    mockAnimationCrash = true;
    jest
      .mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => ({ v: "5.7", layers: [] }) } as Response);
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { container, rerender } = render(<SuspenseLoader fullscreen={false} />);
      await waitFor(() => expect(Sentry.captureException).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("loader-animation")).not.toBeInTheDocument();
      expect(container.querySelector(".animate-spin")!.parentElement).toHaveClass("opacity-100");
      mockQuality = { rendering: "safe", motion: "minimal" };
      rerender(<SuspenseLoader fullscreen={false} />);
      mockQuality = { rendering: "enhanced", motion: "enhanced" };
      rerender(<SuspenseLoader fullscreen={false} />);
      expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("restores the CSS fallback after a loaded player reports renderError and removes its listeners", async () => {
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    jest
      .mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => ({ v: "5.7", layers: [] }) } as Response);
    const { container, rerender } = render(<SuspenseLoader fullscreen={false} />);
    await screen.findByTestId("loader-animation");
    const fallback = container.querySelector(".animate-spin")!.parentElement!;
    act(() => mockPlayerListeners.get("load")?.());
    await waitFor(() => expect(fallback).toHaveClass("opacity-0"));
    expect(mockPlayerListeners.has("renderError")).toBe(true);
    act(() => mockPlayerListeners.get("renderError")?.());
    expect(fallback).toHaveClass("opacity-100");
    expect(screen.queryByTestId("loader-animation")).not.toBeInTheDocument();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockPlayerListeners.size).toBe(0);
    mockQuality = { rendering: "safe", motion: "minimal" };
    rerender(<SuspenseLoader fullscreen={false} />);
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    rerender(<SuspenseLoader fullscreen={false} />);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(mockPlayerListeners.size).toBe(0);
  });

  it("unmounts a hidden player and keeps a visible fallback when the tab returns", async () => {
    mockQuality = { rendering: "enhanced", motion: "enhanced" };
    jest
      .mocked(fetch)
      .mockResolvedValue({ ok: true, json: async () => ({ v: "5.7", layers: [] }) } as Response);
    render(<SuspenseLoader fullscreen={false} />);
    await screen.findByTestId("loader-animation");
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(screen.queryByTestId("loader-animation")).not.toBeInTheDocument();
    expect(mockPlayerListeners.size).toBe(0);
    act(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await screen.findByTestId("loader-animation");
  });
});
