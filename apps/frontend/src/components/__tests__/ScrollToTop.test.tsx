import { render, screen, waitFor } from "@testing-library/react";
import ScrollToTop from "../ScrollToTop";

describe("ScrollToTop mobile clearance", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("stays above the fixed bottom navigation through the lg breakpoint", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: jest.fn().mockReturnValue({
        matches: true,
        media: "(max-width: 1023px)",
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      }),
    });
    const nav = document.createElement("nav");
    nav.dataset.bottomNav = "";
    Object.defineProperty(nav, "offsetHeight", {
      configurable: true,
      value: 79,
    });
    document.body.appendChild(nav);

    render(<ScrollToTop />);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "بازگشت به بالا" })).toHaveStyle(
        "bottom: calc(99px + env(safe-area-inset-bottom))",
      ),
    );
    nav.remove();
  });
});
