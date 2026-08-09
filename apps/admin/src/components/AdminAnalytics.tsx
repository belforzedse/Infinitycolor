"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

type Primitive = string | number | boolean;
type UmamiApi = {
  track: (
    event?:
      | string
      | ((defaults: Record<string, unknown>) => Record<string, unknown>),
    data?: Record<string, Primitive>,
  ) => void;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ADMIN_ANALYTICS_CONSENT_KEY = "infinity_admin_analytics_consent";
export const ADMIN_ANALYTICS_CONSENT_EVENT = "infinity-admin-analytics-consent";

export function adminRouteGroup(pathname: string): string {
  const first =
    pathname.split("?")[0].split("/").filter(Boolean)[0]?.toLowerCase() ??
    "dashboard";
  if (["products", "categories", "tags", "colors"].includes(first))
    return "catalog";
  if (
    [
      "orders",
      "carts",
      "payment-methods",
      "shipping",
      "coupons",
      "general-discounts",
    ].includes(first)
  ) {
    return "commerce";
  }
  if (["users", "customers"].includes(first)) return "customers";
  if (["blog", "faq", "stories", "customization"].includes(first))
    return "content";
  // Keep legacy report bookmarks in the same low-cardinality group after the
  // redirect to the Sales workspace.
  if (first === "sales" || first === "reports") return "reports";
  if (first === "settings") return "settings";
  if (first === "account") return "account";
  if (first === "dashboard" || first === "") return "dashboard";
  return "other-admin";
}

function trackerConfiguration(): {
  baseUrl: string;
  websiteId: string;
  release: string;
} | null {
  const rawUrl = (process.env.NEXT_PUBLIC_ADMIN_UMAMI_URL || "").trim();
  const websiteId = (
    process.env.NEXT_PUBLIC_ADMIN_UMAMI_WEBSITE_ID || ""
  ).trim();
  const rawRelease = (
    process.env.NEXT_PUBLIC_RELEASE_SHA || "development"
  ).trim();
  const release = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(rawRelease)
    ? rawRelease
    : "unknown";
  if (!rawUrl || !UUID_PATTERN.test(websiteId)) return null;
  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return { baseUrl: url.origin, websiteId, release };
  } catch {
    return null;
  }
}

function hasConsent(): boolean {
  try {
    return (
      window.localStorage.getItem(ADMIN_ANALYTICS_CONSENT_KEY) === "granted"
    );
  } catch {
    return false;
  }
}

function trackRoute(group: string): void {
  const api = (window as Window & { umami?: UmamiApi }).umami;
  if (!api) return;
  try {
    // Umami receives a stable route-group URL, never the admin's ids, query
    // strings, tokens, order numbers or customer identifiers.
    api.track((defaults) => ({
      ...defaults,
      url: `/admin-route-group/${group}`,
      title: `admin:${group}`,
    }));
    api.track("admin_navigation", { route_group: group });
  } catch {
    // Analytics must never affect the admin application.
  }
}

export default function AdminAnalytics() {
  const pathname = usePathname() || "/";
  const group = useMemo(() => adminRouteGroup(pathname), [pathname]);
  const configuration = useMemo(() => trackerConfiguration(), []);
  const [consented, setConsented] = useState(false);
  const lastTrackedGroup = useRef("");

  useEffect(() => {
    setConsented(hasConsent());
    const update = () => setConsented(hasConsent());
    window.addEventListener(ADMIN_ANALYTICS_CONSENT_EVENT, update);
    return () =>
      window.removeEventListener(ADMIN_ANALYTICS_CONSENT_EVENT, update);
  }, []);

  useEffect(() => {
    if (!configuration || !consented || lastTrackedGroup.current === group)
      return;
    if (!(window as Window & { umami?: UmamiApi }).umami) return;
    lastTrackedGroup.current = group;
    trackRoute(group);
  }, [configuration, consented, group]);

  if (!configuration || !consented) return null;
  return (
    <Script
      src={`${configuration.baseUrl}/telemetry.js`}
      strategy="afterInteractive"
      data-website-id={configuration.websiteId}
      data-host-url={configuration.baseUrl}
      data-auto-pageview="false"
      data-domains="admin.infinitycolor.co,admin.staging.infinitycolor.co"
      data-tag={configuration.release}
      onLoad={() => {
        if (!(window as Window & { umami?: UmamiApi }).umami) return;
        if (lastTrackedGroup.current === group) return;
        lastTrackedGroup.current = group;
        trackRoute(group);
      }}
    />
  );
}

export { trackerConfiguration };
