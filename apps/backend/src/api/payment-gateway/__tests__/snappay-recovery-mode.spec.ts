import {
  __resetRecoveryReadinessForTests,
  configuredRecoveryMode,
  evaluateRecoveryReadiness,
  getRecoveryMode,
  NOT_FOUND_TAIL_MARGIN_MS,
  parseRecoveryMode,
  recoveryConfig,
} from "../services/snappay-recovery-mode";
import { evaluateReleaseBreakers } from "../services/snappay-recovery-breakers";

jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

const DAY = 24 * 60 * 60 * 1000;

type StubOptions = {
  immutable?: boolean;
  deduplicated?: boolean;
  constrained?: boolean;
  wouldReleaseCount?: number;
  oldestWouldReleaseAgeMs?: number;
  contradictions?: number;
  contradictedTailMs?: number | null;
  recentTerminalCount?: number;
  releasedWalletIrr?: number;
};

/**
 * Minimal Postgres stand-in. Each query the modules issue is matched on a
 * fragment that is unique to it, so a query changing shape fails loudly here
 * instead of silently returning the wrong stub.
 */
function makeStrapi(options: StubOptions = {}) {
  const raw = jest.fn(async (sql: string) => {
    if (sql.includes("pg_trigger")) {
      return { rows: options.immutable === false ? [] : [{ "?column?": 1 }] };
    }
    if (sql.includes("relkind = 'i'")) {
      return { rows: options.deduplicated === false ? [] : [{ "?column?": 1 }] };
    }
    if (sql.includes("pg_constraint")) {
      return { rows: options.constrained === false ? [] : [{ "?column?": 1 }] };
    }
    if (sql.includes("decision = 'would_release'")) {
      const age = options.oldestWouldReleaseAgeMs ?? 30 * DAY;
      return {
        rows: [
          {
            count: options.wouldReleaseCount ?? 500,
            oldest: new Date(Date.now() - age),
          },
        ],
      };
    }
    if (sql.includes("pa.status = 'Succeeded'")) {
      return {
        rows: [
          {
            count: options.contradictions ?? 0,
            tail:
              options.contradictedTailMs === undefined ? null : options.contradictedTailMs,
          },
        ],
      };
    }
    if (sql.includes("COUNT(*)::int AS count") && sql.includes("kind = ANY(?)")) {
      return { rows: [{ count: options.recentTerminalCount ?? 0 }] };
    }
    if (sql.includes("SUM(wallet_amount_irr)")) {
      return { rows: [{ total: options.releasedWalletIrr ?? 0 }] };
    }
    return { rows: [] };
  });
  return {
    db: { connection: { raw, client: { config: { client: "postgres" } } } },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  } as any;
}

const enforceEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({
    SNAPPAY_NOT_FOUND_AUTO_RELEASE_MODE: "enforce",
    SNAPPAY_REGISTERED_AUTO_REVERT_MODE: "enforce",
    SNAPPAY_LATE_SUCCESS_MODE: "enforce",
    SNAPPAY_NOT_FOUND_SEMANTICS_ACK: "SNAPP-1234",
    ...extra,
  }) as NodeJS.ProcessEnv;

beforeEach(() => {
  __resetRecoveryReadinessForTests();
  jest.clearAllMocks();
});

describe("parseRecoveryMode", () => {
  it("defaults to off and never upgrades an unrecognised value", () => {
    expect(parseRecoveryMode(undefined)).toBe("off");
    expect(parseRecoveryMode("")).toBe("off");
    expect(parseRecoveryMode("ENFORCE ")).toBe("enforce");
    expect(parseRecoveryMode("Shadow")).toBe("shadow");
    // A typo must not be the reason money moved.
    expect(parseRecoveryMode("enforcce")).toBe("off");
    expect(parseRecoveryMode("true")).toBe("off");
    expect(parseRecoveryMode(1)).toBe("off");
  });

  it("treats an unset late-success mode as shadow, not as silence", () => {
    // Once the sweep stamps a timed-out attempt terminal, an unrouted late OK
    // callback is dropped without a trace. `off` must still observe and park.
    expect(configuredRecoveryMode("late_success", {} as NodeJS.ProcessEnv)).toBe("shadow");
    expect(configuredRecoveryMode("not_found", {} as NodeJS.ProcessEnv)).toBe("off");
    expect(configuredRecoveryMode("registered", {} as NodeJS.ProcessEnv)).toBe("off");
  });
});

describe("evaluateRecoveryReadiness", () => {
  it("defaults every release path to off when nothing is configured", async () => {
    const strapi = makeStrapi();
    const readiness = await evaluateRecoveryReadiness(strapi, {} as NodeJS.ProcessEnv);
    expect(readiness.paths.not_found.effective).toBe("off");
    expect(readiness.paths.registered.effective).toBe("off");
    expect(readiness.paths.late_success.effective).toBe("shadow");
    expect(getRecoveryMode("not_found")).toBe("off");
  });

  it("allows enforce once every prerequisite is met", async () => {
    const strapi = makeStrapi();
    const readiness = await evaluateRecoveryReadiness(strapi, enforceEnv());
    expect(readiness.paths.not_found.effective).toBe("enforce");
    expect(readiness.paths.not_found.blockedBy).toEqual([]);
    expect(getRecoveryMode("registered")).toBe("enforce");
  });

  it("degrades to shadow without the SnappPay NOT_FOUND semantics ACK", async () => {
    const strapi = makeStrapi();
    const env = enforceEnv();
    delete env.SNAPPAY_NOT_FOUND_SEMANTICS_ACK;
    const readiness = await evaluateRecoveryReadiness(strapi, env);
    expect(readiness.paths.not_found.effective).toBe("shadow");
    expect(readiness.paths.not_found.blockedBy).toContain("semantics_ack_missing");
    // The other two paths do not depend on that answer.
    expect(readiness.paths.registered.effective).toBe("enforce");
  });

  it("degrades every path when the evidence vocabulary is unconstrained", async () => {
    // A misspelt `decision` would otherwise be invisible to the breakers and
    // free to be written twice, since both guards filter on the exact strings.
    const readiness = await evaluateRecoveryReadiness(
      makeStrapi({ constrained: false }),
      enforceEnv(),
    );
    expect(readiness.paths.registered.effective).toBe("shadow");
    expect(readiness.paths.registered.blockedBy).toContain("evidence_vocabulary_unconstrained");
  });

  it("degrades every path when the evidence table is not append-only", async () => {
    const strapi = makeStrapi({ immutable: false, deduplicated: false });
    const readiness = await evaluateRecoveryReadiness(strapi, enforceEnv());
    for (const path of ["not_found", "registered", "late_success"] as const) {
      expect(readiness.paths[path].effective).toBe("shadow");
      expect(readiness.paths[path].blockedBy).toContain("evidence_trigger_missing");
    }
  });

  it("refuses a minimum token age that does not clear the measured tail", async () => {
    // Production already proves a 1007 read at 23.4 minutes can still settle.
    const contradictedTailMs = 23.4 * 60 * 1000;
    const tooLow = await evaluateRecoveryReadiness(
      makeStrapi({ contradictedTailMs }),
      enforceEnv({
        SNAPPAY_NOT_FOUND_MIN_TOKEN_AGE_MS: String(contradictedTailMs + 60_000),
      }),
    );
    expect(tooLow.paths.not_found.blockedBy).toContain("min_token_age_below_measured_tail");
    expect(tooLow.paths.not_found.effective).toBe("shadow");

    const clears = await evaluateRecoveryReadiness(
      makeStrapi({ contradictedTailMs }),
      enforceEnv({
        SNAPPAY_NOT_FOUND_MIN_TOKEN_AGE_MS: String(
          contradictedTailMs + NOT_FOUND_TAIL_MARGIN_MS,
        ),
      }),
    );
    expect(clears.paths.not_found.effective).toBe("enforce");
  });

  it("refuses enforce while shadow evidence is thin, young, or contradicted", async () => {
    const thin = await evaluateRecoveryReadiness(
      makeStrapi({ wouldReleaseCount: 12 }),
      enforceEnv(),
    );
    expect(thin.paths.not_found.blockedBy).toContain("shadow_sample_too_small");

    const young = await evaluateRecoveryReadiness(
      makeStrapi({ oldestWouldReleaseAgeMs: 2 * DAY }),
      enforceEnv(),
    );
    expect(young.paths.not_found.blockedBy).toContain("shadow_window_too_short");

    const contradicted = await evaluateRecoveryReadiness(
      makeStrapi({ contradictions: 1, contradictedTailMs: 60_000 }),
      enforceEnv(),
    );
    expect(contradicted.paths.not_found.blockedBy).toContain(
      "shadow_contradicted_by_settlement",
    );
  });

  it("stays out of enforce when the shadow statistics cannot be read at all", async () => {
    const strapi = makeStrapi();
    strapi.db.connection.raw = jest.fn(async (sql: string) => {
      if (sql.includes("pg_trigger") || sql.includes("relkind = 'i'")) {
        return { rows: [{ ok: 1 }] };
      }
      throw new Error("connection reset");
    });
    const readiness = await evaluateRecoveryReadiness(strapi, enforceEnv());
    expect(readiness.paths.not_found.effective).toBe("shadow");
    expect(readiness.paths.not_found.blockedBy).toContain("shadow_stats_unreadable");
  });
});

describe("recoveryConfig", () => {
  it("falls back to the documented defaults", () => {
    const config = recoveryConfig({} as NodeJS.ProcessEnv);
    expect(config.notFoundMinTokenAgeMs).toBe(30 * 60 * 1000);
    expect(config.notFoundConfirmDelayMs).toBe(3 * 60 * 1000);
    expect(config.failedNotFoundMinTokenAgeMs).toBe(10 * 60 * 1000);
    expect(config.registeredRevertAfterMs).toBe(30 * 60 * 1000);
    expect(config.maxAutoReleasePer15m).toBe(30);
    expect(config.reconcileMaxAgeHours).toBe(48);
    // Unset wallet limits are null, which the breaker reads as "fail closed".
    expect(config.maxWalletIrrPer24h).toBeNull();
    expect(config.maxSingleWalletIrr).toBeNull();
  });
});

describe("evaluateReleaseBreakers", () => {
  const params = {
    path: "not_found" as const,
    kinds: ["not_found_confirmed" as const],
  };

  it("refuses wallet-bearing releases while the value limits are unset", async () => {
    const verdict = await evaluateReleaseBreakers(makeStrapi(), {
      ...params,
      walletAmountIrr: 1_000_000,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(verdict).toEqual({
      open: true,
      decision: "refused_breaker_value",
      reason: "wallet_value_limits_unset",
    });
  });

  it("still releases a stock-only attempt while the value limits are unset", async () => {
    const verdict = await evaluateReleaseBreakers(makeStrapi(), {
      ...params,
      walletAmountIrr: 0,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(verdict).toEqual({ open: false });
  });

  it("parks a single oversized wallet leg", async () => {
    const verdict = await evaluateReleaseBreakers(makeStrapi(), {
      ...params,
      walletAmountIrr: 9_000_000,
      env: {
        SNAPPAY_AUTO_RELEASE_MAX_SINGLE_WALLET_IRR: "5000000",
        SNAPPAY_AUTO_RELEASE_MAX_WALLET_IRR_PER_24H: "50000000",
      } as NodeJS.ProcessEnv,
    });
    expect(verdict).toMatchObject({ open: true, decision: "refused_single_cap" });
  });

  it("trips on the 15-minute count", async () => {
    const verdict = await evaluateReleaseBreakers(makeStrapi({ recentTerminalCount: 30 }), {
      ...params,
      walletAmountIrr: 0,
      env: { SNAPPAY_AUTO_RELEASE_MAX_PER_15M: "30" } as NodeJS.ProcessEnv,
    });
    expect(verdict).toMatchObject({ open: true, decision: "refused_breaker_count" });
  });

  it("trips on the 24-hour wallet value, counting the pending release", async () => {
    const env = {
      SNAPPAY_AUTO_RELEASE_MAX_SINGLE_WALLET_IRR: "9000000",
      SNAPPAY_AUTO_RELEASE_MAX_WALLET_IRR_PER_24H: "10000000",
    } as NodeJS.ProcessEnv;
    const strapi = makeStrapi({ releasedWalletIrr: 9_500_000 });

    await expect(
      evaluateReleaseBreakers(strapi, { ...params, walletAmountIrr: 1_000_000, env }),
    ).resolves.toMatchObject({ open: true, decision: "refused_breaker_value" });

    await expect(
      evaluateReleaseBreakers(makeStrapi({ releasedWalletIrr: 1_000_000 }), {
        ...params,
        walletAmountIrr: 1_000_000,
        env,
      }),
    ).resolves.toEqual({ open: false });
  });
});
