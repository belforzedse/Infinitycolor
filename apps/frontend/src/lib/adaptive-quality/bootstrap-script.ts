import {
  ADAPTIVE_QUALITY_BUILD_VERSION,
  ADAPTIVE_QUALITY_FLAGS,
  ADAPTIVE_QUALITY_POLICY_VERSION,
  ADAPTIVE_QUALITY_SCHEMA,
  ADAPTIVE_QUALITY_SESSION_TTL_MS,
  ADAPTIVE_QUALITY_STORAGE_KEY,
} from "./config";

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
    ttl: ADAPTIVE_QUALITY_SESSION_TTL_MS,
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
          typeof value.expiresAt === "number" &&
          value.expiresAt > now &&
          Number.isInteger(value.rolloutBucket) &&
          value.rolloutBucket >= 0 &&
          value.rolloutBucket <= 9999 &&
          validConstraint(value.constraint)
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

      const cleanReasons = (reasons) => {
        const values = Array.isArray(reasons)
          ? reasons.filter((reason) => allowedReasons.has(reason))
          : [];
        return [...new Set(values.length ? values : ["default"])].slice(0, 8);
      };
      const counter = (value) =>
        Number.isInteger(value) && value >= 0 ? Math.min(value, 1000000) : 0;
      const save = (constraint, reasons) => {
        const value = {
          schema: C.schema,
          policyVersion: C.policyVersion,
          buildVersion: C.buildVersion,
          expiresAt: now + C.ttl,
          rolloutBucket,
          constraint,
          reasons: cleanReasons(reasons),
          smoothWindows: counter(record && record.smoothWindows),
          smoothRouteGenerations: counter(record && record.smoothRouteGenerations),
          lastSmoothRouteGeneration: counter(record && record.lastSmoothRouteGeneration),
          sessionHadDowngrade: Boolean(record && record.sessionHadDowngrade === true),
          sessionHadSevereEvent: Boolean(record && record.sessionHadSevereEvent === true)
        };
        try {
          sessionStorage.setItem(C.storageKey, JSON.stringify(value));
        } catch {}
        return value;
      };

      const inCohort =
        C.forceSafe || rolloutBucket < C.rolloutPercent * 100;
      if (!inCohort) {
        const constraint = validConstraint(record && record.constraint)
          ? record.constraint
          : { rendering: "standard", media: "standard", motion: "standard" };
        const saved = save(constraint, record && record.reasons);
        w.__INFINITY_AQ_BOOTSTRAP__ = {
          schema: C.schema,
          policyVersion: C.policyVersion,
          buildVersion: C.buildVersion,
          expiresAt: saved.expiresAt,
          rolloutBucket,
          reasons: saved.reasons,
          constraint,
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

      const mediaMatch = (query) => {
        try {
          return typeof matchMedia === "function"
            ? matchMedia(query).matches
            : undefined;
        } catch {
          return undefined;
        }
      };
      const connection = n.connection || n.mozConnection || n.webkitConnection;
      const memory =
        typeof n.deviceMemory === "number" &&
        Number.isFinite(n.deviceMemory) &&
        n.deviceMemory > 0 &&
        n.deviceMemory <= 64
          ? n.deviceMemory
          : undefined;
      const cores =
        typeof n.hardwareConcurrency === "number" &&
        Number.isInteger(n.hardwareConcurrency) &&
        n.hardwareConcurrency > 0 &&
        n.hardwareConcurrency <= 256
          ? n.hardwareConcurrency
          : undefined;
      const reducedMotion = mediaMatch("(prefers-reduced-motion: reduce)");
      const reducedTransparency = mediaMatch(
        "(prefers-reduced-transparency: reduce)"
      );
      const saveData = connection && connection.saveData === true;
      const effectiveType =
        connection && typeof connection.effectiveType === "string"
          ? connection.effectiveType
          : undefined;
      const slowConnection =
        effectiveType === "slow-2g" ||
        effectiveType === "2g" ||
        effectiveType === "3g";

      let constraint = {
        rendering: "standard",
        media: "standard",
        motion: "standard"
      };
      let maximum = {
        rendering: "enhanced",
        media: "high",
        motion: "enhanced"
      };
      let reasons = [];

      if (memory !== undefined && memory <= 2) {
        constraint.rendering = "safe";
        constraint.motion = "minimal";
        maximum.rendering = "safe";
        maximum.motion = "minimal";
        reasons.push("low-memory");
      }
      if (cores !== undefined && cores <= 2) {
        constraint.rendering = "safe";
        constraint.motion = "minimal";
        maximum.rendering = "safe";
        maximum.motion = "minimal";
        reasons.push("low-cores");
      }
      if (
        memory !== undefined &&
        cores !== undefined &&
        memory <= 4 &&
        cores <= 4 &&
        memory > 2 &&
        cores > 2
      ) {
        constraint.rendering = "safe";
        constraint.motion = "minimal";
        maximum.rendering = "safe";
        maximum.motion = "minimal";
        reasons.push("combined-capacity");
      }
      if (saveData || slowConnection) maximum.media = "economy";
      if (reducedMotion) maximum.motion = "minimal";

      if (record && validConstraint(record.constraint)) {
        const next = clamp(constraint, record.constraint);
        if (
          next.rendering !== constraint.rendering ||
          next.media !== constraint.media ||
          next.motion !== constraint.motion
        ) {
          reasons.push("session-constraint");
        }
        constraint = next;
        reasons.push(...cleanReasons(record.reasons));
      }

      if (C.forceSafe) {
        constraint = {
          rendering: "safe",
          media: "economy",
          motion: "minimal"
        };
        maximum = { ...constraint };
        reasons = ["force-safe"];
      } else {
        constraint = clamp(constraint, maximum);
        if (reducedMotion) reasons.push("reduced-motion");
        if (saveData) reasons.push("save-data");
        else if (slowConnection) reasons.push("slow-connection");
        if (reducedTransparency) reasons.push("reduced-transparency");
      }

      reasons = cleanReasons(reasons);
      const saved = save(constraint, reasons);
      const snapshot = {
        schema: C.schema,
        policyVersion: C.policyVersion,
        buildVersion: C.buildVersion,
        expiresAt: saved.expiresAt,
        rolloutBucket,
        reasons: saved.reasons,
        constraint,
        enabled: true,
        rendering: constraint.rendering,
        media: constraint.media,
        motion: constraint.motion,
        reducedTransparency: reducedTransparency === true,
        reason: saved.reasons[0] || "default",
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
