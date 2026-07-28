"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import {
  ADAPTIVE_QUALITY_EVENT,
  ADAPTIVE_QUALITY_FLAGS,
  ADAPTIVE_QUALITY_PROMOTION_EVENT,
} from "@/lib/adaptive-quality/config";
import {
  getAdaptiveObservationSummary,
  getAdaptiveRolloutBucket,
  getLoadedEnhancements,
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";
import type { AdaptiveQualityChange } from "@/lib/adaptive-quality";
import { getAdaptiveRouteGroup } from "@/lib/adaptive-quality/route-group";
import {
  ANALYTICS_CONSENT_EVENT,
  getAnalyticsConsent,
  trackMatomoEvent,
} from "@/lib/analytics/matomo";

const ROUTE_SUMMARY_DELAY_MS = 8_500;
const ENHANCEMENT_FAMILIES = [
  "hero-motion",
  "carousel-motion",
  "lottie-loader",
  "quick-view",
  "share",
  "glass-surface",
  "optional-gif",
  "optional-video",
  "secondary-media",
  "social-media",
] as const;
type WebVitalsMetric = Parameters<
  Parameters<typeof useReportWebVitals>[0]
>[0];

function hasAnalyticsConsent(): boolean {
  try {
    return getAnalyticsConsent() === "granted";
  } catch {
    return false;
  }
}

function tierName(value: {
  rendering: string;
  media: string;
  motion: string;
  reason: string;
}) {
  return `r:${value.rendering}|m:${value.media}|o:${value.motion}|reason:${value.reason}`;
}

function shouldSample(percent: number): boolean {
  if (percent >= 100) return true;
  if (percent <= 0) return false;
  return getAdaptiveRolloutBucket() < percent * 100;
}

export default function AdaptiveQualityTelemetry() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const quality = useAdaptiveQuality();
  const [consentGranted, setConsentGranted] = useState(false);
  const routeGroup = useMemo(
    () =>
      getAdaptiveRouteGroup(
        pathname || "/",
        Boolean(searchParams?.get("search") || searchParams?.get("q")),
      ),
    [pathname, searchParams],
  );

  useEffect(() => {
    setConsentGranted(hasAnalyticsConsent());
    const handleConsent = () => setConsentGranted(hasAnalyticsConsent());
    window.addEventListener(ANALYTICS_CONSENT_EVENT, handleConsent);
    return () =>
      window.removeEventListener(ANALYTICS_CONSENT_EVENT, handleConsent);
  }, []);

  useEffect(() => {
    if (!ADAPTIVE_QUALITY_FLAGS.telemetry || !consentGranted || !quality.enabled) {
      return;
    }

    const handleChange = (event: Event) => {
      const change = (event as CustomEvent<AdaptiveQualityChange>).detail;
      if (!change) return;
      const tierChanged =
        change.previous.rendering !== change.current.rendering ||
        change.previous.media !== change.current.media ||
        change.previous.motion !== change.current.motion ||
        change.previous.reducedTransparency !==
          change.current.reducedTransparency;
      if (!tierChanged) return;

      trackMatomoEvent({
        category: "adaptive_quality",
        action: "tier_change",
        name: `${routeGroup}|${tierName(change.current)}`,
      });
    };

    const handlePromotionEligible = () => {
      trackMatomoEvent({
        category: "adaptive_quality",
        action: "promotion_eligible",
        name: `${routeGroup}|${tierName(quality)}`,
        onceKey: `aq-promotion-eligible-${quality.routeGeneration}`,
      });
    };

    window.addEventListener(ADAPTIVE_QUALITY_EVENT, handleChange);
    window.addEventListener(
      ADAPTIVE_QUALITY_PROMOTION_EVENT,
      handlePromotionEligible,
    );
    return () => {
      window.removeEventListener(ADAPTIVE_QUALITY_EVENT, handleChange);
      window.removeEventListener(
        ADAPTIVE_QUALITY_PROMOTION_EVENT,
        handlePromotionEligible,
      );
    };
  }, [consentGranted, quality, routeGroup]);

  useEffect(() => {
    if (!ADAPTIVE_QUALITY_FLAGS.telemetry || !consentGranted || !quality.enabled) {
      return;
    }
    const samplePercent =
      routeGroup === "cart" || routeGroup === "checkout" ? 100 : 25;
    if (!shouldSample(samplePercent)) return;

    const timeoutId = window.setTimeout(() => {
      const loaded = getLoadedEnhancements();
      const enhancementFlags = ENHANCEMENT_FAMILIES.map(
        (family) => `${family}:${loaded.has(family) ? 1 : 0}`,
      ).join(",");
      const observation = getAdaptiveObservationSummary();
      const detailedObserver = shouldSample(1)
        ? `|observer:${observation.observer}`
        : "";
      trackMatomoEvent({
        category: "adaptive_quality",
        action: "route_summary",
        name:
          `${routeGroup}|${tierName(quality)}` +
          `|samples:${observation.sampleCount}` +
          `|issues:${observation.issueCount}` +
          `|severe:${observation.severeCount}` +
          `|enh:${enhancementFlags}` +
          detailedObserver,
        value: Array.from(loaded).length,
        onceKey: `aq-route-${quality.routeGeneration}`,
      });
    }, ROUTE_SUMMARY_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [consentGranted, quality, routeGroup]);

  const reportWebVital = useCallback(
    (metric: WebVitalsMetric) => {
      if (
        !ADAPTIVE_QUALITY_FLAGS.telemetry ||
        !consentGranted ||
        !quality.enabled ||
        !shouldSample(
          routeGroup === "cart" || routeGroup === "checkout" ? 100 : 25,
        )
      ) {
        return;
      }
      const value =
        metric.name === "CLS"
          ? Math.round(metric.value * 1_000)
          : Math.round(metric.value);
      const detailed = shouldSample(1) ? `|rating:${metric.rating}` : "";
      trackMatomoEvent({
        category: "adaptive_quality",
        action: `web_vital_${metric.name.toLowerCase()}`,
        name: `${routeGroup}|${tierName(quality)}${detailed}`,
        value,
      });
    },
    [consentGranted, quality, routeGroup],
  );

  useReportWebVitals(reportWebVital);
  return null;
}
