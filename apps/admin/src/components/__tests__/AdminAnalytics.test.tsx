import { act, render, waitFor } from "@testing-library/react";

let pathname = "/";
jest.mock("next/navigation", () => ({ usePathname: () => pathname }));
jest.mock("next/script", () => ({ __esModule: true, default: () => null }));

import AdminAnalytics, {
  ADMIN_ANALYTICS_CONSENT_EVENT,
  ADMIN_ANALYTICS_CONSENT_KEY,
  adminRouteGroup,
} from "../AdminAnalytics";

describe("AdminAnalytics", () => {
  beforeEach(() => {
    pathname = "/";
    localStorage.clear();
    (window as Window & { _paq?: unknown[]; __adminMatomoInitialized?: boolean })._paq = [];
    (window as Window & { __adminMatomoInitialized?: boolean }).__adminMatomoInitialized = false;
    process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL = "https://matomo.example.test";
    process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID = "41";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL;
    delete process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID;
  });

  it.each([
    ["/", "dashboard"],
    ["/products/edit/99", "catalog"],
    ["/orders/secret-order-id", "commerce"],
    ["/reports/traffic?customer=42", "reports"],
    ["/account", "account"],
  ])("maps %s only to its low-cardinality group", (path, expected) => {
    expect(adminRouteGroup(path)).toBe(expected);
  });

  it("is inert without explicit consent", () => {
    render(<AdminAnalytics />);
    expect((window as Window & { _paq?: unknown[] })._paq).toEqual([]);
  });

  it("sends only the group after consent and never the raw route", async () => {
    pathname = "/orders/customer-42?token=secret";
    const { rerender } = render(<AdminAnalytics />);
    localStorage.setItem(ADMIN_ANALYTICS_CONSENT_KEY, "granted");
    act(() => window.dispatchEvent(new Event(ADMIN_ANALYTICS_CONSENT_EVENT)));
    rerender(<AdminAnalytics />);

    await waitFor(() => {
      const serialized = JSON.stringify((window as Window & { _paq?: unknown[] })._paq);
      expect(serialized).toContain("AdminNavigation");
      expect(serialized).toContain("commerce");
      expect(serialized).not.toContain("customer-42");
      expect(serialized).not.toContain("token=secret");
    });
  });
});
