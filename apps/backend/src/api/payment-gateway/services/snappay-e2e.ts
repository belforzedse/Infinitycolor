import type { SnappayCallResult, SnappayEndpoint } from "./snappay";

/**
 * Deterministic SnappPay provider responses for end-to-end tests.
 *
 * SnappPay has no sandbox that can be driven from CI — a real installment
 * checkout needs a real shopper with a real credit line — so the recovery
 * behaviour that matters most cannot otherwise be exercised end to end. The
 * scripts below stand in for the provider and nothing else: every local
 * transition, lock, CAS and evidence write is the production code.
 *
 * `not_found_then_ok` is the load-bearing one. It replays the production case
 * this whole feature is shaped around: a status read at +2 minutes answers 1007
 * NOT_FOUND, the shopper carries on paying, and the payment settles. That
 * happened to 56 of 481 settled attempts in four days, and any implementation
 * that releases the wallet on an early 1007 cancels those customers.
 *
 * Opt-in only, and refused outright in a production build: a stray environment
 * variable must never turn real payments into simulated ones.
 */
export type SnappayE2EScript = "not_found" | "not_found_then_ok" | "registered";

const SCRIPTS: readonly SnappayE2EScript[] = [
  "not_found",
  "not_found_then_ok",
  "registered",
];

export function snappayE2EScript(
  env: NodeJS.ProcessEnv = process.env,
): SnappayE2EScript | null {
  const raw = String(env.SNAPPAY_E2E_STATUS_SCRIPT || "").trim().toLowerCase();
  if (!raw) return null;
  if (!SCRIPTS.includes(raw as SnappayE2EScript)) return null;
  if (String(env.NODE_ENV || "").trim().toLowerCase() === "production") {
    throw new Error(
      "SNAPPAY_SIMULATION_REFUSED: deterministic SnappPay cannot be enabled in a production build",
    );
  }
  return raw as SnappayE2EScript;
}

/** Reads per token, so a script can change its answer as the token ages. */
const reads = new Map<string, number>();

export const resetSnappayE2EState = (): void => {
  reads.clear();
};

const ok = <T>(endpoint: SnappayEndpoint, response: T): SnappayCallResult<T> => ({
  successful: true,
  response,
  diagnostic: { endpoint, httpStatus: 200, providerCode: 0 },
});

const notFound = <T>(endpoint: SnappayEndpoint): SnappayCallResult<T> => ({
  successful: false,
  errorData: { errorCode: 1007, message: "NOT_FOUND" },
  diagnostic: { endpoint, httpStatus: 404, providerCode: 1007 },
});

/**
 * How many reads a script answers 1007 for before the payment appears.
 *
 * Two, so the confirm protocol's *first* read sees NOT_FOUND exactly as
 * production does, and the flow still reaches the OK branch inside one test.
 */
const NOT_FOUND_READS_BEFORE_SUCCESS = 2;

export function snappayE2EStatus(
  script: SnappayE2EScript,
  paymentToken: string,
): SnappayCallResult<{ status: string }> {
  const seen = (reads.get(paymentToken) || 0) + 1;
  reads.set(paymentToken, seen);

  switch (script) {
    case "registered":
      return ok("status", { status: "REGISTERED" });
    case "not_found":
      return notFound("status");
    case "not_found_then_ok":
      // The production shape: gone at first, then paying, then paid.
      if (seen <= NOT_FOUND_READS_BEFORE_SUCCESS) return notFound("status");
      if (seen === NOT_FOUND_READS_BEFORE_SUCCESS + 1) {
        return ok("status", { status: "PENDING" });
      }
      return ok("status", { status: "VERIFY" });
  }
}

/** Mutating calls all succeed; the script decides what `status` then reports. */
export const snappayE2ESuccess = (endpoint: SnappayEndpoint): SnappayCallResult<any> =>
  ok(endpoint, { status: endpoint.toUpperCase() });
