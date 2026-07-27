import { render, screen } from "@testing-library/react";
import Reveal from "../Reveal";

let mockQuality: {
  motion: "minimal" | "standard" | "enhanced";
  routeGeneration: number;
} = {
  motion: "standard",
  routeGeneration: 0,
};

jest.mock("@/lib/adaptive-quality", () => ({
  useAdaptiveQuality: () => mockQuality,
}));

describe("Reveal adaptive behavior", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it("keeps content visible and creates no observer in Minimal", () => {
    mockQuality = { motion: "minimal", routeGeneration: 0 };
    const observer = jest.fn();
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: observer,
    });

    render(
      <Reveal>
        <span>Semantic content</span>
      </Reveal>,
    );

    expect(screen.getByText("Semantic content").parentElement).toHaveAttribute(
      "data-aq-reveal-state",
      "shown",
    );
    expect(observer).not.toHaveBeenCalled();
  });

  it("disconnects its bounded observer on a tier change", () => {
    const disconnect = jest.fn();
    const observe = jest.fn();
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      value: jest.fn(() => ({
        observe,
        unobserve: jest.fn(),
        disconnect,
      })),
    });
    mockQuality = { motion: "standard", routeGeneration: 0 };

    const { rerender } = render(
      <Reveal>
        <span>Observed content</span>
      </Reveal>,
    );
    expect(observe).toHaveBeenCalledTimes(1);

    mockQuality = { motion: "minimal", routeGeneration: 0 };
    rerender(
      <Reveal>
        <span>Observed content</span>
      </Reveal>,
    );
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Observed content").parentElement).toHaveAttribute(
      "data-aq-reveal-state",
      "shown",
    );
  });
});
