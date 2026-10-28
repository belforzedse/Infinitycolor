"use client";

import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import Script from "next/script";
import { usePathname, useSearchParams } from "next/navigation";
import { useAtomValue } from "jotai";
import { currentUserAtom } from "@/lib/atoms/auth";
import {
  analyticsBeforeSend,
  deleteAnalyticsContext,
  flushPendingAnalytics,
  identify,
  isAnalyticsEnabled,
  resetIdentity,
  setAnalyticsContext,
  trackPage,
} from "@/lib/analytics";

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_RELEASE_TAG = /^[a-zA-Z0-9_.-]{1,64}$/;

export function normalizeUmamiBaseUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw.trim());
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) return null;
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    if (parsed.pathname !== "/" && parsed.pathname !== "") return null;
    return trimTrailingSlash(parsed.origin);
  } catch {
    return null;
  }
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

export function derivePageType(pathname: string): string {
  if (!pathname || pathname === "/") return "home";
  const first = pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  if (first === "pdp") return "pdp";
  if (first === "plp" || first === "categories") return "plp";
  if (first === "search") return "search";
  if (first === "cart") return "cart";
  if (first === "checkout" || first === "payment") return "checkout";
  if (first === "orders") return "orders";
  if (first === "blog") return "blog";
  if (["account", "addresses", "wallet", "likes"].includes(first)) return "account";
  return "other";
}

export function AnalyticsTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const currentUser = useAtomValue(currentUserAtom);
  const lastTrackedPathRef = useRef("");
  const pendingTrackedPathRef = useRef("");
  const previousUrlRef = useRef("");

  const baseUrl = normalizeUmamiBaseUrl(process.env.NEXT_PUBLIC_UMAMI_URL || "");
  const websiteId = (process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID || "").trim();
  const releaseTag = (process.env.NEXT_PUBLIC_RELEASE_SHA || "").trim();
  const enabled = isAnalyticsEnabled() && Boolean(baseUrl && CANONICAL_UUID.test(websiteId));

  const currentPath = useMemo(() => {
    const query = searchParams?.toString();
    return query ? `${pathname}?${query}` : pathname || "/";
  }, [pathname, searchParams]);

  const routePath = currentPath;

  useIsomorphicLayoutEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    window.__infinityAnalyticsBeforeSend = analyticsBeforeSend;
    return () => {
      delete window.__infinityAnalyticsBeforeSend;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    if (lastTrackedPathRef.current === routePath || pendingTrackedPathRef.current === routePath) {
      return;
    }

    // Product/category dimensions are action-scoped. Clear the previous page
    // before the new route's server component can set its stable context.
    deleteAnalyticsContext("product_id");
    deleteAnalyticsContext("category_id");
    setAnalyticsContext("route_group", derivePageType(routePath.split("?")[0] || "/"));
    const absoluteUrl = `${window.location.origin}${routePath}`;
    const referrerUrl = previousUrlRef.current || document.referrer || undefined;

    let raf2 = 0;
    pendingTrackedPathRef.current = routePath;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        if (pendingTrackedPathRef.current !== routePath) return;
        pendingTrackedPathRef.current = "";
        lastTrackedPathRef.current = routePath;
        trackPage({ url: absoluteUrl, title: document.title, referrerUrl });
        previousUrlRef.current = absoluteUrl;
      });
    });

    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2) window.cancelAnimationFrame(raf2);
      if (pendingTrackedPathRef.current === routePath) pendingTrackedPathRef.current = "";
    };
  }, [routePath, enabled]);

  // Only a signed-in customer's opaque id is ever sent. `identify` skips a
  // repeat of the active id, and signing out only forgets it locally.
  useEffect(() => {
    if (!enabled) return;
    const userId = (currentUser as { id?: number | string } | null)?.id;
    if (userId !== undefined && userId !== null && String(userId).trim()) {
      identify(userId);
    } else {
      resetIdentity();
    }
  }, [currentUser, enabled]);

  if (!enabled) return null;

  return (
    <Script
      src={`${baseUrl!}/telemetry.js`}
      strategy="afterInteractive"
      data-website-id={websiteId}
      data-host-url={baseUrl!}
      data-auto-pageview="false"
      data-before-send="__infinityAnalyticsBeforeSend"
      data-performance="true"
      data-tag={SAFE_RELEASE_TAG.test(releaseTag) ? releaseTag : undefined}
      onLoad={flushPendingAnalytics}
    />
  );
}
