/**
 * In-process counters for the `incrementMetric` helpers that were previously
 * dead code.
 *
 * `expireStockReservations.ts` and its siblings have always called
 * `strapi.metrics.increment(...)`, but nothing ever assigned `strapi.metrics`,
 * so every one of those calls returned without recording anything. The sweep's
 * `snappay.reservation.released_unresolved` signal — the one that says stock was
 * freed while the payment was still unresolved — has therefore never been
 * observable anywhere.
 *
 * This is deliberately a plain map, not a metrics backend: the counters are read
 * off `/_health`, they reset on restart, and nothing makes a decision from them.
 * Anything a decision depends on lives in `payment_attempt_evidence`.
 */
export type MetricsRegistry = {
  increment(name: string, by?: number): void;
  snapshot(): Record<string, number>;
  reset(): void;
};

export function createMetricsRegistry(): MetricsRegistry {
  const counters = new Map<string, number>();
  return {
    increment(name: string, by = 1) {
      const key = String(name || "").slice(0, 120);
      if (!key) return;
      const step = Number.isFinite(by) ? by : 1;
      counters.set(key, (counters.get(key) || 0) + step);
    },
    snapshot() {
      return Object.fromEntries([...counters.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
    reset() {
      counters.clear();
    },
  };
}

/**
 * Records a counter without caring whether the registry was installed. Callers
 * in job and service code use this rather than reaching for `strapi.metrics`
 * directly, so a boot order that has not reached `bootstrap` yet is a no-op
 * instead of a crash.
 */
export function incrementMetric(strapi: unknown, name: string, by = 1): void {
  const registry = (strapi as any)?.metrics;
  if (registry && typeof registry.increment === "function") {
    registry.increment(name, by);
  }
}

export function metricsSnapshot(strapi: unknown): Record<string, number> {
  const registry = (strapi as any)?.metrics;
  return registry && typeof registry.snapshot === "function" ? registry.snapshot() : {};
}
