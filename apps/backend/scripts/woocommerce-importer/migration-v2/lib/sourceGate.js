"use strict";

/**
 * A hold-and-resume gate for the WooCommerce source.
 *
 * Why this exists: on 2026-09-13 a ~4 minute WooCommerce outage killed a
 * cutover campaign 90 seconds in. `catalog/engine.js#preflight` burned its four
 * `GET /products` attempts (60s timeout each) and threw, which rejected the
 * catalog branch, which failed the whole campaign. Woo answered normally again
 * minutes later. Nothing was wrong with the run — the source blinked.
 *
 * The existing `CATALOG_RUN_PAUSED` machinery is the wrong tool for that. It is
 * a *persist-and-exit* pause: the run throws, lands `paused` in the run store,
 * and waits for an operator to type `resume <runId>`. It is also unreachable
 * from a campaign, which passes no `runStore` to `runSync` at all — so
 * `runContext` is null and `ensureRunCanContinue` returns immediately. Turning a
 * 4-minute blip into "stopped until somebody notices" is not an improvement on
 * failing.
 *
 * This gate is the other kind of pause: hold *in process* until the source
 * answers again, then carry on from the same request. Callers that exhaust
 * their normal retry budget against a transport failure park here instead of
 * throwing.
 *
 * Two properties matter:
 *
 * - **Single-flight.** A campaign runs many Woo requests concurrently (entity
 *   concurrency 24, plus a page prefetch window). When the source drops, all of
 *   them fail at once. They must share one hold and one probe loop, or a dead
 *   source gets hammered by dozens of probes and the log becomes unreadable.
 * - **Bounded.** A hold is capped (`maxHoldMs`). A genuine multi-hour outage
 *   must still end as a failed campaign, and it must say `SOURCE_UNAVAILABLE`
 *   rather than the generic `ERROR` the 2026-09-13 row recorded.
 *
 * Source-only. `migration-v2/lib/http.js` is shared by three source readers and
 * the destination writer; the gate is opt-in per client and must never be given
 * to the Strapi writer. A destination outage should fail fast — holding a
 * campaign open because *we* are down helps nobody.
 */

const DEFAULT_MAX_HOLD_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PROBE_INTERVAL_MS = 120_000;
const PROGRESS_LOG_EVERY_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sourceUnavailable(heldMs, alreadyExhausted) {
  const error = new Error(
    alreadyExhausted
      ? "WooCommerce already declared unreachable earlier in this run"
      : `WooCommerce still unreachable after holding ${Math.round(heldMs / 60000)}m`,
  );
  error.code = "SOURCE_UNAVAILABLE";
  return error;
}

class SourceGate {
  /**
   * @param {object} opts
   * @param {() => Promise<unknown>} opts.probe Resolves when the source is healthy, rejects otherwise.
   * @param {{ info: Function, warn: Function }} [opts.logger]
   * @param {number} [opts.maxHoldMs] Cap on a single continuous hold.
   * @param {number} [opts.probeIntervalMs] Delay before the first probe, then backed off.
   * @param {number} [opts.maxProbeIntervalMs]
   * @param {(ms: number) => Promise<void>} [opts.sleepFn]
   * @param {() => number} [opts.now]
   */
  constructor(opts = {}) {
    if (typeof opts.probe !== "function") {
      throw new TypeError("SourceGate requires a probe function");
    }
    this.probe = opts.probe;
    this.logger = opts.logger || { info() {}, warn() {} };
    this.maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
    this.probeIntervalMs = opts.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.maxProbeIntervalMs = opts.maxProbeIntervalMs ?? DEFAULT_MAX_PROBE_INTERVAL_MS;
    this.sleepFn = opts.sleepFn || sleep;
    this.now = opts.now || (() => Date.now());

    /** @type {Promise<void> | null} The in-flight hold, shared by every waiter. */
    this._inFlight = null;
    /**
     * Set once a hold has run out its budget. Every later call fails instantly
     * instead of opening a fresh one.
     *
     * Without this the cap is decorative. Both entity loops swallow per-item
     * errors — `fullOrders` and `fullUsersAndWallets` do `catch { failed += 1 }`,
     * and the catalog's per-product catch re-throws only `isRunControlError`. So
     * a permanently dead source would give every single entity its own full
     * 60-minute hold: the campaign would never fail, it would grind at roughly
     * an hour each across 188k customers. Sticky exhaustion means that once the
     * source is declared down, the run is never slower than it was before this
     * feature existed, whatever each call site chooses to do with the error.
     */
    this.exhausted = false;
    this.metrics = { holds: 0, heldMs: 0, probes: 0, longestHoldMs: 0 };
  }

  /**
   * Clear sticky exhaustion so a later job can hold again. The long-running
   * worker keeps one service (and so one gate) across every hourly poll and
   * nightly campaign; without a reset per job, one bad night would disable
   * holding until the container restarted.
   */
  reset() {
    this.exhausted = false;
  }

  /** True while the source is considered down and callers are parked. */
  get holding() {
    return this._inFlight !== null;
  }

  /**
   * Park until the source answers a probe. Resolves when it recovers; rejects
   * with `SOURCE_UNAVAILABLE` once `maxHoldMs` is exhausted.
   *
   * Concurrent callers join the hold that is already running rather than
   * starting their own — see the single-flight note above.
   *
   * @param {{ reason?: string }} [context] Included in the log line that opens the hold.
   */
  async holdUntilHealthy(context = {}) {
    if (this.exhausted) throw sourceUnavailable(this.metrics.longestHoldMs, true);
    if (this._inFlight) return this._inFlight;
    this._inFlight = this._runHold(context).finally(() => {
      this._inFlight = null;
    });
    return this._inFlight;
  }

  async _runHold(context) {
    const startedAt = this.now();
    const deadline = startedAt + this.maxHoldMs;
    this.metrics.holds += 1;

    this.logger.warn(
      `⏸ WooCommerce unreachable (${context.reason || "transport failure"}) — holding the run; `
        + `probing every ${Math.round(this.probeIntervalMs / 1000)}s for up to `
        + `${Math.round(this.maxHoldMs / 60000)}m`,
    );

    let interval = this.probeIntervalMs;
    let lastProgressLog = startedAt;

    for (;;) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;

      await this.sleepFn(Math.min(interval, remaining));

      this.metrics.probes += 1;
      let healthy = false;
      let probeError = null;
      try {
        await this.probe();
        healthy = true;
      } catch (error) {
        probeError = error;
      }

      const heldMs = this.now() - startedAt;

      if (healthy) {
        this.metrics.heldMs += heldMs;
        this.metrics.longestHoldMs = Math.max(this.metrics.longestHoldMs, heldMs);
        this.logger.info(
          `▶ WooCommerce reachable again after ${Math.round(heldMs / 1000)}s — resuming`,
        );
        return;
      }

      if (this.now() - lastProgressLog >= PROGRESS_LOG_EVERY_MS) {
        lastProgressLog = this.now();
        this.logger.warn(
          `⏸ still holding — WooCommerce down ${Math.round(heldMs / 60000)}m `
            + `(${probeError?.code || probeError?.message || "probe failed"})`,
        );
      }

      interval = Math.min(Math.round(interval * 1.5), this.maxProbeIntervalMs);
    }

    const heldMs = this.now() - startedAt;
    this.metrics.heldMs += heldMs;
    this.metrics.longestHoldMs = Math.max(this.metrics.longestHoldMs, heldMs);
    this.exhausted = true;
    this.logger.warn(
      `✖ WooCommerce still unreachable after ${Math.round(heldMs / 60000)}m — giving up; `
        + "further requests will fail immediately",
    );
    throw sourceUnavailable(heldMs, false);
  }
}

/**
 * Build a gate, or `null` when holding is switched off
 * (`WOOCOMMERCE_SYNC_SOURCE_HOLD_MAX_MS=0`).
 *
 * Returning null rather than a zero-budget gate matters: a client with no gate
 * takes the original code path and throws the transport error itself, so
 * disabling the feature restores the exact previous behaviour instead of
 * swapping one error for `SOURCE_UNAVAILABLE`.
 *
 * @param {ConstructorParameters<typeof SourceGate>[0]} opts
 * @returns {SourceGate | null}
 */
function createSourceGate(opts = {}) {
  const maxHoldMs = opts.maxHoldMs ?? DEFAULT_MAX_HOLD_MS;
  if (!(maxHoldMs > 0)) return null;
  return new SourceGate({ ...opts, maxHoldMs });
}

module.exports = { SourceGate, createSourceGate, DEFAULT_MAX_HOLD_MS };
