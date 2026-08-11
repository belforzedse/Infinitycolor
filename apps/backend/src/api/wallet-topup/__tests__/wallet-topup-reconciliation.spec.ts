import {
  classifyMellatTopupInquiry,
  isMellatTopupSettleConfirmed,
  markWalletTopupUnknown,
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
});
