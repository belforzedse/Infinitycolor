import { render } from "@testing-library/react";
import SuspenseLoader from "../SuspenseLoader";

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
  noteEnhancementLoaded: (...args: unknown[]) =>
    mockNoteEnhancementLoaded(...args),
}));

describe("SuspenseLoader adaptive gate", () => {
  beforeEach(() => {
    mockHydrated = true;
    mockQuality = { rendering: "safe", motion: "minimal" };
    mockNoteEnhancementLoaded.mockClear();
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
});
