import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_FLAGS,
  ADAPTIVE_QUALITY_LEGACY_STORAGE_KEYS,
  ADAPTIVE_QUALITY_POLICY_CONFIG,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_SESSION_TTL_MS,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "./config";
import { HIGH_END_ANDROID_PATTERN_SOURCE } from "./high-end-user-agent";

/**
 * Runs synchronously in the document head. The returned browser source has no
 * imports or fetches and treats every optional browser/storage API as fallible.
 */
export function getAdaptiveQualityBootstrapScript(): string {
  const config = JSON.stringify({
    schema: ADAPTIVE_QUALITY_SCHEMA,
    policyVersion: ADAPTIVE_QUALITY_POLICY_VERSION,
    buildVersion: ADAPTIVE_QUALITY_BUILD_VERSION,
    storageKey: ADAPTIVE_QUALITY_STORAGE_KEY,
    legacyStorageKeys: ADAPTIVE_QUALITY_LEGACY_STORAGE_KEYS,
    ttl: ADAPTIVE_QUALITY_SESSION_TTL_MS,
    policy: ADAPTIVE_QUALITY_POLICY_CONFIG,
    highEndAndroidPattern: HIGH_END_ANDROID_PATTERN_SOURCE,
    enabled: ADAPTIVE_QUALITY_FLAGS.enabled,
    rolloutPercent: ADAPTIVE_QUALITY_FLAGS.rolloutPercent,
    forceSafe: ADAPTIVE_QUALITY_FLAGS.forceSafe,
  });

  return `;(() => {
    try {
      const C = ${config};
      const w = window;
      const d = document;
      const n = navigator;
      const path = location.pathname;
      if (!C.enabled || path === "/super-admin" || path.startsWith("/super-admin/")) return;

      const renderingOrder = ["safe", "standard", "enhanced"];
      const mediaOrder = ["economy", "standard", "high"];
      const motionOrder = ["minimal", "standard", "enhanced"];
      const allowedReasons = new Set([
        "default", "reduced-motion", "reduced-transparency", "save-data",
        "slow-connection", "low-memory", "low-cores", "combined-capacity",
        "repeated-loaf", "severe-loaf", "repeated-long-task",
        "severe-long-task", "raf-jank", "session-constraint", "force-safe",
        "promotion"
      ]);
      const validConstraint = (value) =>
        value &&
        typeof value === "object" &&
        renderingOrder.includes(value.rendering) &&
        mediaOrder.includes(value.media) &&
        motionOrder.includes(value.motion);
      const validTimestamp = (value) =>
        value === null ||
        (typeof value === "number" && Number.isFinite(value) && value >= 0);
      const clamp = (value, maximum) => ({
        rendering:
          renderingOrder[
            Math.min(
              renderingOrder.indexOf(value.rendering),
              renderingOrder.indexOf(maximum.rendering)
            )
          ],
        media:
          mediaOrder[
            Math.min(
              mediaOrder.indexOf(value.media),
              mediaOrder.indexOf(maximum.media)
            )
          ],
        motion:
          motionOrder[
            Math.min(
              motionOrder.indexOf(value.motion),
              motionOrder.indexOf(maximum.motion)
            )
          ]
      });
      const counter = (value) =>
        Number.isInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
      const mediaMatch = (query) => {
        try {
          return typeof matchMedia === "function"
            ? matchMedia(query).matches
            : undefined;
        } catch {
          return undefined;
        }
      };
      const readConnection = () => {
        try {
          return n.connection || n.mozConnection || n.webkitConnection;
        } catch {
          return undefined;
        }
      };
      const readNumber = (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0
          ? value
          : undefined;
      const readInteger = (value) => {
        const result = readNumber(value);
        return Number.isInteger(result) ? result : undefined;
      };
      const readNavigatorValue = (key) => {
        try {
          return { value: n[key], failed: false };
        } catch {
          return { value: undefined, failed: true };
        }
      };
      const now = Date.now();
      let record = null;

      try {
        const raw = sessionStorage.getItem(C.storageKey);
        const value = raw ? JSON.parse(raw) : null;
        if (
          value &&
          value.schema === C.schema &&
          value.policyVersion === C.policyVersion &&
          value.buildVersion === C.buildVersion &&
          typeof value.createdAt === "number" &&
          Number.isFinite(value.createdAt) &&
          typeof value.expiresAt === "number" &&
          Number.isFinite(value.expiresAt) &&
          value.createdAt <= value.expiresAt &&
          value.expiresAt === value.createdAt + C.ttl &&
          value.expiresAt > now &&
          Number.isInteger(value.rolloutBucket) &&
          value.rolloutBucket >= 0 &&
          value.rolloutBucket <= 9999 &&
          validConstraint(value.runtimeConstraint) &&
          validTimestamp(value.penaltyExpiresAt) &&
          validTimestamp(value.lastBadAt) &&
          allowedReasons.has(value.lastReason)
        ) {
          record = value;
        }
      } catch {}

      let rolloutBucket = record ? record.rolloutBucket : null;
      if (rolloutBucket === null) {
        try {
          const values = new Uint32Array(1);
          crypto.getRandomValues(values);
          rolloutBucket = values[0] % 10000;
        } catch {
          rolloutBucket = Math.floor(Math.random() * 10000);
        }
      }

      const connection = readConnection();
      const reducedMotion = mediaMatch("(prefers-reduced-motion: reduce)");
      const reducedTransparency = mediaMatch(
        "(prefers-reduced-transparency: reduce)"
      );
      const finePointer = mediaMatch("(pointer: fine)");
      const hover = mediaMatch("(hover: hover)");
      const saveData = connection && connection.saveData === true;
      const effectiveType =
        connection && typeof connection.effectiveType === "string"
          ? connection.effectiveType
          : undefined;
      const coresReport = readNavigatorValue("hardwareConcurrency");
      const memoryReport = readNavigatorValue("deviceMemory");
      const cores = readInteger(coresReport.value);
      const memory = readNumber(memoryReport.value);
      const capableDesktop =
        !coresReport.failed &&
        !memoryReport.failed &&
        finePointer === true &&
        hover === true &&
        typeof cores === "number" &&
        cores >= C.policy.desktop.minimumHardwareConcurrency &&
        (
          memoryReport.value === undefined ||
          memory >= C.policy.desktop.minimumDeviceMemory
        );
      const userAgent =
        typeof n.userAgent === "string" ? n.userAgent.slice(0, 512) : "";
      const highEndAndroidPattern = new RegExp(
        C.highEndAndroidPattern,
        "i"
      );
      const highEndMobile =
        /\\biPhone\\b/i.test(userAgent) ||
        (
          /\\bAndroid\\b/i.test(userAgent) &&
          highEndAndroidPattern.test(userAgent)
        );

      const standard = {
        rendering: "standard",
        media: "standard",
        motion: "standard"
      };
      const peak = {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced"
      };
      const safe = {
        rendering: "safe",
        media: "economy",
        motion: "minimal"
      };
      let baselineConstraint =
        capableDesktop || highEndMobile ? { ...peak } : { ...standard };
      const penaltyActive =
        record &&
        typeof record.penaltyExpiresAt === "number" &&
        record.penaltyExpiresAt > now;
      let runtimeConstraint = penaltyActive
        ? clamp(baselineConstraint, record.runtimeConstraint)
        : { ...baselineConstraint };
      let penaltyExpiresAt = penaltyActive ? record.penaltyExpiresAt : null;
      let consecutiveSmoothWindows = penaltyActive
        ? counter(record.consecutiveSmoothWindows)
        : 0;
      let lastBadAt =
        record && validTimestamp(record.lastBadAt) ? record.lastBadAt : null;
      let lastReason =
        record && allowedReasons.has(record.lastReason)
          ? record.lastReason
          : "default";

      if (C.forceSafe) {
        baselineConstraint = { ...safe };
        runtimeConstraint = { ...safe };
        penaltyExpiresAt = null;
        consecutiveSmoothWindows = 0;
        lastReason = "force-safe";
      }

      const applyLiveOverlays = (constraint) => {
        const result = { ...constraint };
        let reason =
          penaltyActive && !C.forceSafe ? "session-constraint" : lastReason;
        if (!penaltyActive && !C.forceSafe) reason = "default";

        if (reducedMotion === true) {
          result.motion = "minimal";
          reason = "reduced-motion";
        }
        if (saveData) {
          result.media = "economy";
          reason = "save-data";
        } else if (effectiveType === "slow-2g" || effectiveType === "2g") {
          result.media = "economy";
          reason = "slow-connection";
        } else if (effectiveType === "3g") {
          result.media =
            mediaOrder[
              Math.min(
                mediaOrder.indexOf(result.media),
                mediaOrder.indexOf("standard")
              )
            ];
          reason = "slow-connection";
        }
        if (reducedTransparency === true) reason = "reduced-transparency";
        return { constraint: result, reason };
      };

      const createdAt = record ? record.createdAt : now;
      const expiresAt = record ? record.expiresAt : createdAt + C.ttl;
      const save = () => {
        const value = {
          schema: C.schema,
          policyVersion: C.policyVersion,
          buildVersion: C.buildVersion,
          createdAt,
          expiresAt,
          rolloutBucket,
          runtimeConstraint,
          penaltyExpiresAt,
          consecutiveSmoothWindows,
          lastBadAt,
          lastReason
        };
        let succeeded = false;
        try {
          sessionStorage.setItem(C.storageKey, JSON.stringify(value));
          succeeded = true;
        } catch {}
        if (succeeded) {
          try {
            for (const key of C.legacyStorageKeys) sessionStorage.removeItem(key);
          } catch {}
        }
        return value;
      };

      const inCohort =
        C.forceSafe || rolloutBucket < C.rolloutPercent * 100;
      const saved = save();
      if (!inCohort) {
        w.__INFINITY_AQ_BOOTSTRAP__ = {
          ...saved,
          baselineConstraint,
          enabled: false,
          rendering: "enhanced",
          media: "high",
          motion: "enhanced",
          reducedTransparency: false,
          reason: "default",
          routeGeneration: 0
        };
        return;
      }

      const effective = C.forceSafe
        ? { constraint: { ...safe }, reason: "force-safe" }
        : applyLiveOverlays(runtimeConstraint);
      const snapshot = {
        ...saved,
        baselineConstraint,
        enabled: true,
        rendering: effective.constraint.rendering,
        media: effective.constraint.media,
        motion: effective.constraint.motion,
        reducedTransparency: reducedTransparency === true,
        reason: effective.reason,
        routeGeneration: 0
      };
      const root = d.documentElement;
      root.setAttribute("data-aq-scope", "storefront");
      root.setAttribute("data-aq-rendering", snapshot.rendering);
      root.setAttribute("data-aq-media", snapshot.media);
      root.setAttribute("data-aq-motion", snapshot.motion);
      root.setAttribute(
        "data-aq-transparency",
        snapshot.reducedTransparency ? "reduced" : "normal"
      );
      w.__INFINITY_AQ_BOOTSTRAP__ = snapshot;
    } catch {}
  })();`;
}
