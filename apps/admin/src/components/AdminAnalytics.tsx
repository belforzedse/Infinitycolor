"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type MatomoCommand = [string, ...unknown[]];

export const ADMIN_ANALYTICS_CONSENT_KEY = "infinity_admin_analytics_consent";
export const ADMIN_ANALYTICS_CONSENT_EVENT = "infinity-admin-analytics-consent";

export function adminRouteGroup(pathname: string): string {
  const first = pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "dashboard";
  if (["products", "categories", "tags", "colors"].includes(first)) return "catalog";
  if (["orders", "carts", "payment-methods", "shipping", "coupons", "general-discounts"].includes(first)) {
    return "commerce";
  }
  if (["users", "customers"].includes(first)) return "customers";
  if (["blog", "faq", "stories", "customization"].includes(first)) return "content";
  // "reports" is the legacy prefix, kept so redirected bookmarks group with the
  // Sales workspace they now land in.
  if (first === "sales" || first === "reports") return "reports";
  if (first === "settings") return "settings";
  if (first === "account") return "account";
  if (first === "dashboard" || first === "") return "dashboard";
  return "other-admin";
}

function trackerConfiguration(): { baseUrl: string; siteId: string } | null {
  const rawUrl = process.env.NEXT_PUBLIC_ADMIN_MATOMO_URL?.trim();
  const siteId = process.env.NEXT_PUBLIC_ADMIN_MATOMO_SITE_ID?.trim();
  if (!rawUrl || !siteId || !/^\d+$/.test(siteId)) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
    return { baseUrl: url.href.replace(/\/$/, ""), siteId };
  } catch {
    return null;
  }
}

function hasConsent(): boolean {
  return window.localStorage.getItem(ADMIN_ANALYTICS_CONSENT_KEY) === "granted";
}

export default function AdminAnalytics() {
  const pathname = usePathname() || "/";
  const group = useMemo(() => adminRouteGroup(pathname), [pathname]);
  const configuration = useMemo(trackerConfiguration, []);
  const [consented, setConsented] = useState(false);

  useEffect(() => {
    setConsented(hasConsent());
    const update = () => setConsented(hasConsent());
    window.addEventListener(ADMIN_ANALYTICS_CONSENT_EVENT, update);
    return () => window.removeEventListener(ADMIN_ANALYTICS_CONSENT_EVENT, update);
  }, []);

  useEffect(() => {
    if (!configuration || !consented) return;
    const win = window as Window & { _paq?: MatomoCommand[]; __adminMatomoInitialized?: boolean };
    win._paq = win._paq || [];
    if (!win.__adminMatomoInitialized) {
      win._paq.push(["setTrackerUrl", `${configuration.baseUrl}/matomo.php`]);
      win._paq.push(["setSiteId", configuration.siteId]);
      win._paq.push(["disableCookies"]);
      win.__adminMatomoInitialized = true;
    }
    // Matomo otherwise derives the current raw URL. A fixed route-group URL
    // prevents dynamic ids, queries, customer ids, and order ids from leaving
    // the admin origin while retaining useful low-cardinality navigation data.
    win._paq.push(["setCustomUrl", `/admin-route-group/${group}`]);
    win._paq.push(["trackEvent", "AdminNavigation", group]);
  }, [configuration, consented, group]);

  if (!configuration || !consented) return null;
  return (
    <Script
      src={`${configuration.baseUrl}/matomo.js`}
      strategy="afterInteractive"
      data-admin-matomo-site-id={configuration.siteId}
    />
  );
}
