"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  useAdaptiveQuality,
} from "@/lib/adaptive-quality";
import type { AdaptiveQualityChange } from "@/lib/adaptive-quality";
import { getAdaptiveRouteGroup } from "@/lib/adaptive-quality/route-group";
import { ANALYTICS_CONSENT_EVENT, getAnalyticsConsent, trackAnalyticsEvent } from "@/lib/analytics";

const ROUTE_SUMMARY_DELAY_MS = 8_500;
type WebVitalsMetric = Parameters<Parameters<typeof useReportWebVitals>[0]>[0];

function hasAnalyticsConsent(): boolean {
  try {
    return getAnalyticsConsent() === "granted";
  } catch {
    return false;
  }
}

function tierName(value: { rendering: string; media: string; motion: string }) {
  return `r:${value.rendering}|m:${value.media}|o:${value.motion}`;
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
  const [consentGranted, setConsentGranted] = useState(hasAnalyticsConsent);
  const routeGroup = useMemo(
    () =>
      getAdaptiveRouteGroup(
        pathname || "/",
        Boolean(searchParams?.get("search") || searchParams?.get("q")),
      ),
    [pathname, searchParams],
  );
  const contextRef = useRef({ consentGranted, quality, routeGroup });

  useEffect(() => {
    contextRef.current = { consentGranted, quality, routeGroup };
  }, [consentGranted, quality, routeGroup]);

  useEffect(() => {
    const handleConsent = () => setConsentGranted(hasAnalyticsConsent());
    window.addEventListener(ANALYTICS_CONSENT_EVENT, handleConsent);
    return () => window.removeEventListener(ANALYTICS_CONSENT_EVENT, handleConsent);
  }, []);

  useEffect(() => {
    if (!ADAPTIVE_QUALITY_FLAGS.telemetry || !consentGranted) return;

    const handleChange = (event: Event) => {
      const context = contextRef.current;
      if (!context.quality.enabled) return;
      const change = (event as CustomEvent<AdaptiveQualityChange>).detail;
      if (!change) return;
      const tierChanged =
        change.previous.rendering !== change.current.rendering ||
        change.previous.media !== change.current.media ||
        change.previous.motion !== change.current.motion ||
        change.previous.reducedTransparency !== change.current.reducedTransparency;
      if (!tierChanged) return;

      const marker =
        change.reason === "promotion"
          ? "recovery"
          : change.reason === "reduced-motion" ||
              change.reason === "reduced-transparency" ||
              change.reason === "save-data" ||
              change.reason === "slow-connection"
            ? "overlay"
            : "downgrade";
      trackAnalyticsEvent({
        category: "adaptive_quality",
        action: "tier_change",
        properties: {
          route_group: context.routeGroup,
          experiment: `aq:${tierName(change.current)}|reason:${change.reason}|marker:${marker}`,
        },
      });
    };

    const handleRecovery = () => {
      const context = contextRef.current;
      if (!context.quality.enabled) return;
      trackAnalyticsEvent({
        category: "adaptive_quality",
        action: "recovery_step",
        properties: {
          route_group: context.routeGroup,
          experiment: `aq:${tierName(context.quality)}|marker:recovery`,
        },
        onceKey: `aq-recovery-${context.quality.routeGeneration}-${tierName(context.quality)}`,
      });
    };

    window.addEventListener(ADAPTIVE_QUALITY_EVENT, handleChange);
    window.addEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, handleRecovery);
    return () => {
      window.removeEventListener(ADAPTIVE_QUALITY_EVENT, handleChange);
      window.removeEventListener(ADAPTIVE_QUALITY_PROMOTION_EVENT, handleRecovery);
    };
  }, [consentGranted]);

  useEffect(() => {
    if (!ADAPTIVE_QUALITY_FLAGS.telemetry || !consentGranted || !quality.enabled) {
      return;
    }
    const samplePercent = routeGroup === "cart" || routeGroup === "checkout" ? 100 : 25;
    if (!shouldSample(samplePercent)) return;

    const timeoutId = window.setTimeout(() => {
      const observation = getAdaptiveObservationSummary();
      trackAnalyticsEvent({
        category: "adaptive_quality",
        action: "route_summary",
        properties: {
          route_group: routeGroup,
          experiment: `aq:${tierName(quality)}|observer:${observation.observer}`,
        },
        onceKey: `aq-route-${quality.routeGeneration}`,
      });
    }, ROUTE_SUMMARY_DELAY_MS);

    return () => window.clearTimeout(timeoutId);
  }, [consentGranted, quality, routeGroup]);

  const reportWebVital = useCallback((metric: WebVitalsMetric) => {
    const {
      consentGranted: currentConsent,
      quality: currentQuality,
      routeGroup: currentRouteGroup,
    } = contextRef.current;
    if (
      !ADAPTIVE_QUALITY_FLAGS.telemetry ||
      !currentConsent ||
      !currentQuality.enabled ||
      !shouldSample(currentRouteGroup === "cart" || currentRouteGroup === "checkout" ? 100 : 25)
    ) {
      return;
    }
    trackAnalyticsEvent({
      category: "adaptive_quality",
      action: `web_vital_${metric.name.toLowerCase()}`,
      properties: {
        route_group: currentRouteGroup,
        experiment: `aq:${tierName(currentQuality)}|rating:${metric.rating}`,
      },
    });
  }, []);

  useReportWebVitals(reportWebVital);
  return null;
}
