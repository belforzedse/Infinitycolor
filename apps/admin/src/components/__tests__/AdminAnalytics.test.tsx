import { act, render, waitFor } from "@testing-library/react";
import React from "react";

let pathname = "/";
const track = jest.fn();

jest.mock("next/navigation", () => ({ usePathname: () => pathname }));
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

import AdminAnalytics, {
  ADMIN_ANALYTICS_CONSENT_EVENT,
  ADMIN_ANALYTICS_CONSENT_KEY,
  adminRouteGroup,
} from "../AdminAnalytics";

describe("AdminAnalytics", () => {
  beforeEach(() => {
    pathname = "/";
    track.mockReset();
    localStorage.clear();
    (window as Window & { umami?: { track: typeof track } }).umami = { track };
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL = "https://analytics.example.test";
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID =
      "123e4567-e89b-12d3-a456-426614174000";
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL;
    delete process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID;
    delete (window as Window & { umami?: unknown }).umami;
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
    expect(track).not.toHaveBeenCalled();
  });

  it("loads the private tracker and sends a stable group after consent", async () => {
    pathname = "/orders/customer-42?token=secret";
    localStorage.setItem(ADMIN_ANALYTICS_CONSENT_KEY, "granted");
    const { container } = render(<AdminAnalytics />);
    act(() => window.dispatchEvent(new Event(ADMIN_ANALYTICS_CONSENT_EVENT)));

    await waitFor(() => {
      const script = container.querySelector("script");
      expect(script).toHaveAttribute(
        "src",
        "https://analytics.example.test/telemetry.js",
      );
      expect(script).toHaveAttribute(
        "data-website-id",
        "123e4567-e89b-12d3-a456-426614174000",
      );
      expect(track).toHaveBeenCalled();
      const serialized = JSON.stringify(track.mock.calls);
      expect(serialized).toContain("commerce");
      expect(serialized).not.toContain("customer-42");
      expect(serialized).not.toContain("token=secret");
    });
  });
});
