/**
 * Real-Postgres proof that terminal financial evidence is append-only.
 *
 * §10 of the recovery plan proves the existing JSONB CAS does *not* give this
 * guarantee: `mergeSnappayAttemptObservation` guards only `status <>
 * 'Succeeded'`, `provider_status` is overwritten by any later observation, the
 * merge is shallow so stale keys persist, and generation rotation replaces
 * `terminalEvidence` wholesale. That is why 56 settled production attempts
 * still carry `providerCode: 1007` beside `endpoint: settle, httpStatus: 200`.
 *
 * Everything below is asserted against the real database, through both the raw
 * SQL path and Strapi's entity layer, because a trigger that only stops one of
 * them is not immutability.
 */
import {
  ensurePaymentAttemptEvidenceInvariants,
  paymentAttemptEvidenceIsConstrained,
  paymentAttemptEvidenceIsDeduplicated,
  paymentAttemptEvidenceIsImmutable,
  EVIDENCE_TABLE,
} from "../../../api/payment-attempt-evidence/services/evidence-database";
import {
  EVIDENCE_UID,
  countRecentTerminalDecisions,
  hasTerminalEvidence,
  listEvidenceForAttempt,
  listNotFoundReads,
  recordEvidence,
  recordEvidenceSafely,
  sumRecentReleasedWalletIrr,
} from "../../../api/payment-attempt-evidence/services/evidence";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;

// Attempt ids are synthetic: the evidence table deliberately carries plain
// integers rather than a Strapi relation, so a row never needs the attempt to
// exist and can never be cascaded away with it.
let nextAttemptId = 900_000;
const freshAttemptId = () => (nextAttemptId += 1);

beforeAll(async () => {
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
});

const insert = (attemptId: number, overrides: Record<string, unknown> = {}) =>
  recordEvidence(strapi, {
    attemptId,
    orderId: 42,
    kind: "not_found_read",
    mode: "shadow",
    decision: "observed",
    ...overrides,
  } as any);

describe("payment_attempt_evidence invariants", () => {
  it("installs the immutability trigger, the uniqueness index and the vocabulary", async () => {
    await expect(paymentAttemptEvidenceIsImmutable(strapi)).resolves.toBe(true);
    await expect(paymentAttemptEvidenceIsDeduplicated(strapi)).resolves.toBe(true);
    await expect(paymentAttemptEvidenceIsConstrained(strapi)).resolves.toBe(true);
  });

  it("refuses a value outside the recorded vocabulary", async () => {
    // Strapi renders an `enumeration` as plain text with no CHECK, so without
    // the installed constraints a misspelt decision would be accepted and then
    // escape *both* guards that matter: the breakers filter on
    // `decision IN ('released','reverted')`, and so does the unique index.
    await expect(insert(freshAttemptId(), { decision: "releassed" })).rejects.toThrow();
    await expect(insert(freshAttemptId(), { kind: "not_a_real_kind" })).rejects.toThrow();
    await expect(insert(freshAttemptId(), { mode: "enforcce" })).rejects.toThrow();
  });

  it("is idempotent across repeated boots", async () => {
    await ensurePaymentAttemptEvidenceInvariants(strapi);
    await ensurePaymentAttemptEvidenceInvariants(strapi);
    await expect(paymentAttemptEvidenceIsImmutable(strapi)).resolves.toBe(true);
    await expect(paymentAttemptEvidenceIsDeduplicated(strapi)).resolves.toBe(true);

    // A second installer run must not leave a duplicate trigger behind, or
    // every write would raise twice and the error text would be misleading.
    const triggers = await strapi.db.connection.raw(
      `SELECT COUNT(*)::int AS count
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = ? AND NOT t.tgisinternal`,
      [EVIDENCE_TABLE],
    );
    expect(Number(triggers.rows[0].count)).toBe(1);
  });

  it("refuses UPDATE and DELETE from raw SQL", async () => {
    const attemptId = freshAttemptId();
    const row = await insert(attemptId);
    expect(row?.id).toBeGreaterThan(0);

    await expect(
      strapi.db.connection.raw(`UPDATE ${EVIDENCE_TABLE} SET decision = 'released' WHERE id = ?`, [
        row!.id,
      ]),
    ).rejects.toThrow(/append-only/i);

    await expect(
      strapi.db.connection.raw(`DELETE FROM ${EVIDENCE_TABLE} WHERE id = ?`, [row!.id]),
    ).rejects.toThrow(/append-only/i);

    const survivors = await listEvidenceForAttempt(strapi, attemptId);
    expect(survivors).toHaveLength(1);
    expect(survivors[0].decision).toBe("observed");
  });

  it("refuses UPDATE and DELETE from Strapi's entity layer", async () => {
    const attemptId = freshAttemptId();
    const row = await insert(attemptId);

    await expect(
      strapi.db.query(EVIDENCE_UID).update({
        where: { id: row!.id },
        data: { decision: "released" },
      }),
    ).rejects.toThrow(/append-only/i);

    await expect(
      strapi.db.query(EVIDENCE_UID).delete({ where: { id: row!.id } }),
    ).rejects.toThrow(/append-only/i);

    const survivors = await listEvidenceForAttempt(strapi, attemptId);
    expect(survivors).toHaveLength(1);
  });

  it("allows one money-moving decision per (attempt, kind) and no more", async () => {
    const attemptId = freshAttemptId();
    await insert(attemptId, { kind: "not_found_confirmed", decision: "released" });

    await expect(
      insert(attemptId, { kind: "not_found_confirmed", decision: "released" }),
    ).rejects.toThrow();

    // A different kind is a different decision and is allowed.
    await expect(
      insert(attemptId, { kind: "registered_reverted", decision: "reverted" }),
    ).resolves.toBeTruthy();

    await expect(hasTerminalEvidence(strapi, attemptId)).resolves.toBe(true);
    await expect(
      hasTerminalEvidence(strapi, attemptId, ["late_success_reverted"]),
    ).resolves.toBe(false);
  });

  it("leaves observational rows unconstrained so reads can be counted", async () => {
    const attemptId = freshAttemptId();
    for (let index = 0; index < 3; index += 1) {
      await insert(attemptId, { tokenAgeMs: 120_000 * (index + 1) });
    }
    const reads = await listNotFoundReads(strapi, attemptId, "not_found_read");
    expect(reads).toHaveLength(3);
    expect(reads.map((read) => read.tokenAgeMs)).toEqual([120_000, 240_000, 360_000]);
    // Oldest first: the confirm protocol measures the gap between the first and
    // the current read, so the ordering is load-bearing.
    expect(reads[0].id).toBeLessThan(reads[2].id);
  });

  it("never lets a lost audit line fail an observational caller", async () => {
    const attemptId = freshAttemptId();
    await insert(attemptId, { kind: "not_found_confirmed", decision: "released" });
    await expect(
      recordEvidenceSafely(strapi, {
        attemptId,
        kind: "not_found_confirmed",
        mode: "enforce",
        decision: "released",
      } as any),
    ).resolves.toBeNull();
  });

  it("feeds the breakers from the table rather than from provider JSON", async () => {
    const attemptId = freshAttemptId();
    await insert(attemptId, {
      kind: "not_found_confirmed",
      decision: "released",
      walletAmountIrr: 2_500_000,
    });

    const count = await countRecentTerminalDecisions(strapi, {
      kinds: ["not_found_confirmed"],
      windowMs: 15 * 60 * 1000,
    });
    expect(count).toBeGreaterThanOrEqual(1);

    const total = await sumRecentReleasedWalletIrr(strapi, { windowMs: 24 * 60 * 60 * 1000 });
    expect(total).toBeGreaterThanOrEqual(2_500_000);

    // The window genuinely ages rows out: evaluated an hour from now, a
    // one-second window starts after everything written here.
    const aged = await countRecentTerminalDecisions(strapi, {
      kinds: ["not_found_confirmed"],
      windowMs: 1_000,
      now: new Date(Date.now() + 60 * 60 * 1000),
    });
    expect(aged).toBe(0);
  });

  it("commits or rolls back the evidence row with its financial transaction", async () => {
    const attemptId = freshAttemptId();

    // A release whose surrounding transaction aborts must leave no evidence:
    // the row exists if and only if the release committed.
    await expect(
      strapi.db.transaction(async ({ trx }: any) => {
        await recordEvidence(
          strapi,
          {
            attemptId,
            kind: "not_found_confirmed",
            mode: "enforce",
            decision: "released",
          } as any,
          trx,
        );
        throw new Error("ROLLBACK_THE_RELEASE");
      }),
    ).rejects.toThrow("ROLLBACK_THE_RELEASE");

    expect(await listEvidenceForAttempt(strapi, attemptId)).toHaveLength(0);

    await strapi.db.transaction(async ({ trx }: any) => {
      await recordEvidence(
        strapi,
        {
          attemptId,
          kind: "not_found_confirmed",
          mode: "enforce",
          decision: "released",
        } as any,
        trx,
      );
    });
    expect(await hasTerminalEvidence(strapi, attemptId)).toBe(true);
  });
});
