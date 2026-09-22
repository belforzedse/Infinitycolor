import type { Strapi } from "@strapi/strapi";

/**
 * Advisory-lock key for the payment-attempt evidence schema work. Distinct from
 * the SnappPay family (827453100-102), the external-identity migration
 * (827453105), the payment-attempt invariants (827453106) and the wallet
 * invariants (827453114) — see CLAUDE.md's advisory-lock-key registry.
 */
const EVIDENCE_MIGRATION_LOCK_KEY = 827453116;

export const EVIDENCE_TABLE = "payment_attempt_evidence";
export const EVIDENCE_IMMUTABLE_TRIGGER = "trg_payment_attempt_evidence_immutable";
export const EVIDENCE_IMMUTABLE_FUNCTION = "payment_attempt_evidence_immutable";
export const EVIDENCE_TERMINAL_UNIQUE_INDEX = "idx_payment_attempt_evidence_terminal_once";

/**
 * The decisions that moved money or stock. Exactly one row per (attempt, kind)
 * may carry one, which is what makes a release idempotent at the database level
 * rather than only inside a transaction.
 */
export const EVIDENCE_TERMINAL_DECISIONS = ["released", "reverted"] as const;

/**
 * The uniqueness index is expression-only, for the reason documented in
 * `snappay-database.ts` and `wallet-database.ts`: Strapi 4's PostgreSQL
 * inspector mistakes a column-based UNIQUE index for a constraint and
 * crash-loops trying to `ALTER TABLE ... DROP CONSTRAINT` it on the next schema
 * sync. An expression contributes `attnum = 0`, which its `getIndexes` join on
 * `pg_attribute` cannot see, so this one survives every boot.
 *
 * That is why the uniqueness is a concatenated text key rather than the natural
 * `(attempt_id, kind) WHERE decision IN (...)` partial index: a partial index
 * over plain columns would still be column-based. Nothing queries through it —
 * it exists only to make a duplicate money-moving decision fail the INSERT.
 *
 * The two lookup indexes are deliberately *not* expression-only: the planner
 * only uses an expression index when the query repeats the expression, so an
 * expression-wrapped `attempt_id` would never be read. They are plain column
 * indexes like `idx_payment_attempts_snappay_due` in `snappay-database.ts`;
 * Strapi may drop them on a schema sync, and this installer — which runs in
 * `bootstrap`, after sync, on every boot — puts them straight back.
 */
const EVIDENCE_INDEX_STATEMENTS = [
  // One money-moving decision per (attempt, kind). Everything else — the
  // `observed`, `would_*` and `refused_*` rows — is deliberately unconstrained,
  // because the confirm protocol counts them.
  `CREATE UNIQUE INDEX IF NOT EXISTS ${EVIDENCE_TERMINAL_UNIQUE_INDEX}
   ON ${EVIDENCE_TABLE} ((
     CASE
       WHEN decision IN ('released', 'reverted')
       THEN attempt_id::text || ':' || kind
       ELSE NULL
     END
   ))`,
  // Attempt lookup: the confirm protocol's read count, the admin diagnostics
  // list and `loadAttemptBundle`'s evidence attachment all filter by attempt.
  `CREATE INDEX IF NOT EXISTS idx_payment_attempt_evidence_attempt
   ON ${EVIDENCE_TABLE} (attempt_id, kind)`,
  // Breaker and readiness windows scan by decision over a time range.
  `CREATE INDEX IF NOT EXISTS idx_payment_attempt_evidence_decision_window
   ON ${EVIDENCE_TABLE} (decision, created_at)`,
] as const;

const EVIDENCE_KINDS = [
  "not_found_read",
  "not_found_confirmed",
  "failed_then_not_found",
  "registered_aged",
  "registered_reverted",
  "local_ttl",
  "local_ceiling",
  "provider_revert",
  "provider_cancel",
  "late_success_observed",
  "late_success_reverted",
  "late_success_review",
  "followup",
] as const;

const EVIDENCE_MODES = ["off", "shadow", "enforce"] as const;

const EVIDENCE_DECISIONS = [
  "observed",
  "would_release",
  "released",
  "would_revert",
  "reverted",
  "refused_breaker_count",
  "refused_breaker_value",
  "refused_single_cap",
  "refused_prerequisite",
  "refused_unproven",
  "review",
] as const;

const quoted = (values: readonly string[]): string =>
  values.map((value) => `'${value}'`).join(", ");

/**
 * The vocabulary, enforced in the database.
 *
 * Strapi 4 renders an `enumeration` attribute as a plain text column with no
 * CHECK constraint — the schema diff has no concept of one, which is the same
 * gap documented at `wallet-database.ts:72`. Without these, a typo'd
 * `decision` would be accepted silently and then escape *both* guards that
 * matter: the breakers filter on `decision IN ('released','reverted')`, and so
 * does the partial unique index. A misspelt money-moving decision would
 * therefore be invisible to the circuit breaker and free to be written twice.
 */
const EVIDENCE_CHECK_CONSTRAINTS = [
  {
    name: "chk_payment_attempt_evidence_kind",
    expression: `kind IN (${quoted(EVIDENCE_KINDS)})`,
  },
  {
    name: "chk_payment_attempt_evidence_mode",
    expression: `mode IN (${quoted(EVIDENCE_MODES)})`,
  },
  {
    name: "chk_payment_attempt_evidence_decision",
    expression: `decision IN (${quoted(EVIDENCE_DECISIONS)})`,
  },
  {
    name: "chk_payment_attempt_evidence_attempt",
    expression: "attempt_id IS NOT NULL AND attempt_id > 0",
  },
] as const;

/**
 * Immutability, enforced by the database rather than by discipline.
 *
 * §10 of the recovery plan proves that the existing JSONB CAS does not make
 * provider evidence immutable: `mergeSnappayAttemptObservation` guards only
 * `status <> 'Succeeded'`, `provider_status` is overwritten by any later
 * observation, the merge is shallow so stale keys persist, and generation
 * rotation replaces `terminalEvidence` wholesale. Breakers and readiness
 * therefore read this table, and this table can only ever grow.
 *
 * A trigger is the only mechanism available: Strapi's schema diff has no
 * concept of triggers or functions (the same gap documented for CHECK
 * constraints at `wallet-database.ts:72`), so it neither installs nor removes
 * them. `CREATE OR REPLACE FUNCTION` plus `DROP TRIGGER IF EXISTS` makes the
 * installation idempotent across concurrent boots.
 */
const EVIDENCE_IMMUTABILITY_STATEMENTS = [
  `CREATE OR REPLACE FUNCTION ${EVIDENCE_IMMUTABLE_FUNCTION}()
   RETURNS TRIGGER AS $$
   BEGIN
     RAISE EXCEPTION
       'payment_attempt_evidence is append-only: % on row % is refused',
       TG_OP, COALESCE(OLD.id::text, '?')
       USING ERRCODE = 'restrict_violation';
   END;
   $$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS ${EVIDENCE_IMMUTABLE_TRIGGER} ON ${EVIDENCE_TABLE}`,
  `CREATE TRIGGER ${EVIDENCE_IMMUTABLE_TRIGGER}
   BEFORE UPDATE OR DELETE ON ${EVIDENCE_TABLE}
   FOR EACH ROW EXECUTE FUNCTION ${EVIDENCE_IMMUTABLE_FUNCTION}()`,
] as const;

const isPostgres = (strapi: Strapi): boolean => {
  const client = String(
    (strapi.db.connection as any)?.client?.config?.client || "",
  ).toLowerCase();
  return client.includes("pg") || client.includes("postgres");
};

const shortError = (error: unknown): string =>
  String((error as any)?.message || error).slice(0, 300);

/**
 * True when the append-only guarantee is actually installed. No recovery path
 * may run in ENFORCE without it: a mutable evidence table would let a breaker
 * be talked out of tripping and would make a release unprovable after the fact.
 */
export async function paymentAttemptEvidenceIsImmutable(strapi: Strapi): Promise<boolean> {
  if (!isPostgres(strapi)) return false;
  try {
    const result = await strapi.db.connection.raw(
      `SELECT 1
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = ?
          AND c.relname = ?
          AND NOT t.tgisinternal
        LIMIT 1`,
      [EVIDENCE_IMMUTABLE_TRIGGER, EVIDENCE_TABLE],
    );
    return (result?.rows || []).length > 0;
  } catch (error) {
    strapi.log.error(`Could not verify the evidence immutability trigger: ${shortError(error)}`);
    return false;
  }
}

async function evidenceConstraintExists(strapi: Strapi, name: string): Promise<boolean> {
  const result = await strapi.db.connection.raw(
    `SELECT 1 FROM pg_constraint WHERE conname = ? LIMIT 1`,
    [name],
  );
  return (result?.rows || []).length > 0;
}

/** True when the vocabulary constraints are installed and validated. */
export async function paymentAttemptEvidenceIsConstrained(strapi: Strapi): Promise<boolean> {
  if (!isPostgres(strapi)) return false;
  try {
    for (const constraint of EVIDENCE_CHECK_CONSTRAINTS) {
      if (!(await evidenceConstraintExists(strapi, constraint.name))) return false;
    }
    return true;
  } catch (error) {
    strapi.log.error(`Could not verify the evidence vocabulary: ${shortError(error)}`);
    return false;
  }
}

/** True when the one-money-moving-decision-per-attempt index is installed. */
export async function paymentAttemptEvidenceIsDeduplicated(strapi: Strapi): Promise<boolean> {
  if (!isPostgres(strapi)) return false;
  try {
    const result = await strapi.db.connection.raw(
      `SELECT 1 FROM pg_class WHERE relname = ? AND relkind = 'i' LIMIT 1`,
      [EVIDENCE_TERMINAL_UNIQUE_INDEX],
    );
    return (result?.rows || []).length > 0;
  } catch (error) {
    strapi.log.error(`Could not verify the evidence uniqueness index: ${shortError(error)}`);
    return false;
  }
}

/**
 * Asserted in `bootstrap`, after schema sync, on every PostgreSQL boot — the
 * same contract as `ensureSnappayDatabaseInvariants` and
 * `ensureWalletDatabaseInvariants`. Concurrent boots race here, so no single
 * statement failure may take the process down; `evaluateRecoveryReadiness`
 * re-reads the result and keeps every recovery path out of ENFORCE until the
 * guarantees verify.
 */
export async function ensurePaymentAttemptEvidenceInvariants(strapi: Strapi): Promise<void> {
  if (!isPostgres(strapi)) return;

  let locked = false;
  try {
    await strapi.db.connection.raw("SELECT pg_advisory_lock(?)", [EVIDENCE_MIGRATION_LOCK_KEY]);
    locked = true;
  } catch (error) {
    strapi.log.error(
      `Could not acquire the payment-attempt evidence schema lock; proceeding unlocked: ${shortError(error)}`,
    );
  }

  try {
    for (const statement of EVIDENCE_INDEX_STATEMENTS) {
      try {
        await strapi.db.connection.raw(statement);
      } catch (error) {
        const name = statement.match(/idx_[a-z_]+/)?.[0] || "unknown_index";
        strapi.log.error(`Failed to assert evidence invariant ${name}: ${shortError(error)}`);
      }
    }
    for (const constraint of EVIDENCE_CHECK_CONSTRAINTS) {
      try {
        if (await evidenceConstraintExists(strapi, constraint.name)) continue;
        await strapi.db.connection.raw(
          `ALTER TABLE ${EVIDENCE_TABLE}
             ADD CONSTRAINT ${constraint.name} CHECK (${constraint.expression})`,
        );
      } catch (error) {
        strapi.log.error(
          `Failed to assert evidence constraint ${constraint.name}: ${shortError(error)}`,
        );
      }
    }
    for (const statement of EVIDENCE_IMMUTABILITY_STATEMENTS) {
      try {
        await strapi.db.connection.raw(statement);
      } catch (error) {
        strapi.log.error(
          `Failed to assert evidence immutability: ${shortError(error)}`,
        );
      }
    }
  } finally {
    if (locked) {
      await strapi.db.connection
        .raw("SELECT pg_advisory_unlock(?)", [EVIDENCE_MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  }
}

export const __private = {
  EVIDENCE_MIGRATION_LOCK_KEY,
  EVIDENCE_INDEX_STATEMENTS,
  EVIDENCE_IMMUTABILITY_STATEMENTS,
  EVIDENCE_CHECK_CONSTRAINTS,
  EVIDENCE_KINDS,
  EVIDENCE_MODES,
  EVIDENCE_DECISIONS,
};
