import {
  formatReserveCountdown,
  formatReserveDeadline,
  formatReserveRemaining,
  reserveRemaining,
  reserveStateLabel,
} from "../reserveTime";

const NOW = new Date("2026-09-09T10:00:00.000Z").getTime();

describe("reserveTime", () => {
  it("derives remaining time from the server deadline", () => {
    const expiresAt = new Date(NOW + 23 * 3_600_000 + 40 * 60_000).toISOString();
    expect(reserveRemaining(expiresAt, NOW)).toMatchObject({
      hours: 23,
      minutes: 40,
      isExpired: false,
    });
  });

  it("treats a passed deadline as expired rather than negative", () => {
    const expiresAt = new Date(NOW - 60_000).toISOString();
    expect(reserveRemaining(expiresAt, NOW)).toMatchObject({
      totalMs: 0,
      isExpired: true,
    });
  });

  it("treats a missing or invalid deadline as expired", () => {
    expect(reserveRemaining(null, NOW).isExpired).toBe(true);
    expect(reserveRemaining("not-a-date", NOW).isExpired).toBe(true);
  });

  it("renders remaining time with Persian digits", () => {
    const expiresAt = new Date(NOW + 23 * 3_600_000 + 40 * 60_000).toISOString();
    expect(formatReserveRemaining(expiresAt, NOW)).toBe("۲۳ ساعت و ۴۰ دقیقه باقی مانده");
    expect(formatReserveCountdown(expiresAt, NOW)).toBe("۲۳س ۴۰د");
  });

  it("drops the hours segment under an hour", () => {
    const expiresAt = new Date(NOW + 25 * 60_000).toISOString();
    expect(formatReserveRemaining(expiresAt, NOW)).toBe("۲۵ دقیقه باقی مانده");
  });

  it("says the window closed instead of showing zeros", () => {
    const past = new Date(NOW - 1).toISOString();
    expect(formatReserveRemaining(past, NOW)).toBe("مهلت به پایان رسیده است");
    expect(formatReserveCountdown(past, NOW)).toBe("پایان یافته");
  });

  it("formats an absolute Jalali deadline", () => {
    const text = formatReserveDeadline("2026-09-11T10:30:00.000Z");
    expect(text).toContain("ساعت");
    expect(text).not.toBe("-");
  });

  it("returns a dash for a missing deadline", () => {
    expect(formatReserveDeadline(null)).toBe("-");
    expect(formatReserveDeadline("nope")).toBe("-");
  });

  it("keeps early release distinguishable from expiry in the label", () => {
    expect(reserveStateLabel("ReadyToFulfill", "Expired")).toBe(
      "مهلت رزرو پایان یافته / آماده ارسال",
    );
    expect(reserveStateLabel("ReadyToFulfill", "ReleasedEarly")).toBe(
      "آماده ارسال (آزادسازی زودهنگام)",
    );
  });

  it("labels every lifecycle state", () => {
    expect(reserveStateLabel("Active")).toBe("رزرو فعال");
    expect(reserveStateLabel("Fulfilling")).toBe("در حال آماده‌سازی");
    expect(reserveStateLabel("Completed")).toBe("ارسال شده");
    expect(reserveStateLabel("Cancelled")).toBe("لغو شده");
    expect(reserveStateLabel(undefined)).toBe("نامشخص");
  });
});
