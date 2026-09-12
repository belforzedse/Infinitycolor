import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import userEvent from "@testing-library/user-event";
import { ConsentManager } from "../ConsentManager";
import {
  ANALYTICS_CONSENT_ATTRIBUTE,
  getAnalyticsConsentBootstrapScript,
} from "@/lib/analytics/consent-bootstrap";

const STORAGE_KEY = "analytics-consent";

/**
 * Runs the real pre-paint bootstrap source the way the document head does, so the
 * tests exercise the script that actually ships rather than a re-implementation.
 */
function runBootstrapScript() {
  // eslint-disable-next-line no-new-func -- executing the shipped browser source is the point
  new Function(getAnalyticsConsentBootstrapScript())();
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute(ANALYTICS_CONSENT_ATTRIBUTE);
});

describe("ConsentManager", () => {
  it("is present in the server HTML so a first visitor's banner paints with the page", () => {
    const html = renderToString(<ConsentManager />);

    expect(html).toContain("data-consent-banner");
    expect(html).toContain("تحلیل تجربه خرید");
  });

  it("keeps the banner mounted when no choice has been stored", () => {
    runBootstrapScript();
    render(<ConsentManager />);

    expect(document.documentElement.getAttribute(ANALYTICS_CONSENT_ATTRIBUTE)).toBe("unknown");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it.each(["granted", "denied"] as const)(
    "marks <html> and unmounts the banner for a visitor who already chose %s",
    (stored) => {
      localStorage.setItem(STORAGE_KEY, stored);
      runBootstrapScript();

      // The attribute is what the CSS gate in globals.css keys on, so it has to be
      // correct before paint — i.e. before React renders at all.
      expect(document.documentElement.getAttribute(ANALYTICS_CONSENT_ATTRIBUTE)).toBe(stored);

      render(<ConsentManager />);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it.each([
    ["پذیرش تحلیل تکمیلی", "granted"],
    ["رد تحلیل تکمیلی", "denied"],
  ] as const)("stores %s and syncs the attribute", async (label, expected) => {
    runBootstrapScript();
    render(<ConsentManager />);

    await userEvent.click(screen.getByLabelText(label));

    expect(localStorage.getItem(STORAGE_KEY)).toBe(expected);
    expect(document.documentElement.getAttribute(ANALYTICS_CONSENT_ATTRIBUTE)).toBe(expected);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("hydrates the server markup without a mismatch for a stored choice", async () => {
    // The banner is in the HTML either way, so the first client render must also
    // render it — otherwise React reports a mismatch that e2e would not catch,
    // because the storefront helper ignores attribute-hydration warnings.
    localStorage.setItem(STORAGE_KEY, "denied");
    runBootstrapScript();

    const container = document.createElement("div");
    container.innerHTML = renderToString(<ConsentManager />);
    document.body.appendChild(container);

    const errors: unknown[] = [];
    const consoleError = jest.spyOn(console, "error").mockImplementation((...args) => {
      errors.push(args[0]);
    });

    try {
      await act(async () => {
        hydrateRoot(container, <ConsentManager />);
      });
    } finally {
      consoleError.mockRestore();
      container.remove();
    }

    expect(errors).toEqual([]);
    expect(container.querySelector("[data-consent-banner]")).toBeNull();
  });
});
