import {
  classifyMellatTopupInquiry,
  claimDueWalletTopups,
  isMellatTopupSettleConfirmed,
  markWalletTopupUnknown,
  moveUncorrelatableSamanTopupsToReview,
} from "../services/wallet-topup";

describe("Mellat wallet top-up reconciliation", () => {
  it.each([
    [45, "settled"],
    [0, "settle"],
    [43, "settle"],
    [46, "settle"],
    [48, "reversed"],
    [null, "unknown"],
    [-999, "unknown"],
  ] as const)("classifies inquiry code %s as %s", (code, expected) => {
    expect(classifyMellatTopupInquiry(code)).toBe(expected);
  });

  it.each([
    [{ success: true, resCode: -1 }, true],
    [{ success: false, resCode: 0 }, true],
    [{ success: false, resCode: 45 }, true],
    [{ success: false, resCode: 43 }, false],
    [{ success: false, resCode: 48 }, false],
  ] as const)("classifies settle result %j", (result, expected) => {
    expect(isMellatTopupSettleConfirmed(result)).toBe(expected);
  });

  it("persists durable 1/5/15/60/360 minute backoff and stops after attempt 12", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 7 }] });
    const strapi: any = { db: { connection: { raw } } };
    const base = Date.now();

    for (const [attempt, expectedMinutes] of [
      [1, 1],
      [2, 5],
      [3, 15],
      [4, 60],
      [5, 360],
      [11, 360],
    ] as const) {
      raw.mockClear();
      await markWalletTopupUnknown(strapi, {
        topupId: 7,
        attempt,
        providerCode: -999,
        error: "transport failure",
      });
      const nextDate = raw.mock.calls[0][1][0] as Date;
      expect(nextDate).toBeInstanceOf(Date);
      expect(nextDate.getTime() - base).toBeGreaterThanOrEqual(expectedMinutes * 60_000 - 1_000);
      expect(nextDate.getTime() - base).toBeLessThanOrEqual(expectedMinutes * 60_000 + 5_000);
    }

    raw.mockClear();
    await markWalletTopupUnknown(strapi, {
      topupId: 7,
      attempt: 12,
      error: "manual review required",
    });
    expect(raw.mock.calls[0][1][0]).toBeNull();
  });

  it("selects the provider-specific durable handle for reconciliation", async () => {
    const raw = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ id: 9 }] })
      .mockResolvedValueOnce({
        rows: [{
          id: 9,
          gateway: "SamanKish",
          provider_reference: null,
          verification_reference: "SAMAN-CANDIDATE",
        }],
      });
    const strapi: any = { db: { connection: { raw } } };

    await expect(claimDueWalletTopups(strapi, 25)).resolves.toHaveLength(1);

    const selectSql = String(raw.mock.calls[0][0]);
    expect(selectSql).toContain("gateway, 'Mellat') = 'Mellat'");
    expect(selectSql).toContain("gateway, 'Mellat') = 'SamanKish'");
    expect(selectSql).toContain("COALESCE(provider_reference, verification_reference)");
    expect(selectSql).toContain("gateway, 'Mellat') = 'ZarinPal'");
  });

  it("can park an unverified callback directly for manual review", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 7 }] });
    const strapi: any = { db: { connection: { raw } } };

    await markWalletTopupUnknown(strapi, {
      topupId: 7,
      error: "untrusted callback failure",
      schedule: false,
    });

    expect(raw.mock.calls[0][1][0]).toBeNull();
  });

  it("moves an expired Saman session with no callback RefNum to operator review", async () => {
    const raw = jest.fn().mockResolvedValue({ rows: [{ id: 7 }] });
    const strapi: any = { db: { connection: { raw } } };

    await expect(
      moveUncorrelatableSamanTopupsToReview(strapi, { graceMinutes: 0 }),
    ).resolves.toEqual({ reviewed: 1 });

    const sql = String(raw.mock.calls[0][0]);
    expect(sql).toContain("gateway = 'SamanKish'");
    expect(sql).toContain("verification_reference IS NULL");
    expect(sql).toContain("ref_id IS NOT NULL");
    expect(sql).toContain("next_reconcile_at = NULL");
  });
});
