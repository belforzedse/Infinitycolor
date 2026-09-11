import {
  extractErrorStatus,
  getUserFacingErrorMessage,
} from "../userErrorMessage";

/**
 * Every failure used to collapse into one sentence — "متأسفانه مشکلی پیش آمد" —
 * so a denied permission, an expired session, a stale record and an unreachable
 * server were indistinguishable and none said what to do next.
 */
describe("getUserFacingErrorMessage", () => {
  it("prefers a message the backend actually sent", () => {
    const message = getUserFacingErrorMessage({
      status: 400,
      response: { data: { error: { message: "Insufficient balance" } } },
    });

    expect(message).toBe("موجودی کیف پول کافی نیست.");
  });

  it("translates a self-wallet adjustment refusal instead of a generic 403", () => {
    const message = getUserFacingErrorMessage({
      status: 403,
      response: {
        data: {
          error: { message: "Administrators cannot adjust their own wallet" },
        },
      },
    });

    expect(message).toBe("تغییر موجودی کیف پول خودتان مجاز نیست.");
  });

  it("passes through a Persian message from the backend unchanged", () => {
    const message = getUserFacingErrorMessage({
      status: 400,
      response: {
        data: { error: { message: "این کد تخفیف برای شما فعال نیست." } },
      },
    });

    expect(message).toBe("این کد تخفیف برای شما فعال نیست.");
  });

  it.each([
    [401, "نشست شما منقضی شده است. دوباره وارد شوید."],
    [
      403,
      "شما به این بخش دسترسی ندارید. اگر لازم است، از مدیر سیستم دسترسی بگیرید.",
    ],
    [404, "این مورد پیدا نشد. ممکن است حذف شده باشد؛ صفحه را تازه کنید."],
    [
      409,
      "این مورد در این فاصله تغییر کرده است. صفحه را تازه کنید و دوباره اقدام کنید.",
    ],
    [
      429,
      "تعداد درخواست‌ها بیش از حد است. چند لحظه صبر کنید و دوباره تلاش کنید.",
    ],
  ])("explains a bare %i with its own next step", (status, expected) => {
    expect(getUserFacingErrorMessage({ status })).toBe(expected);
  });

  it("treats any 5xx as a service failure rather than operator error", () => {
    expect(getUserFacingErrorMessage({ status: 503 })).toBe(
      "سرویس در حال حاضر پاسخ نمی‌دهد. کمی بعد دوباره تلاش کنید.",
    );
  });

  it("does not tell the operator a blind retry is safe when the outcome is unknown", () => {
    const message = getUserFacingErrorMessage(new TypeError("Failed to fetch"));

    expect(message).toContain("از ثبت‌نشدن تغییر مطمئن شوید");
    // The old copy invited an immediate repeat, which can double-apply a mutation.
    expect(message).not.toBe("متأسفانه مشکلی پیش آمد. لطفاً دوباره تلاش کنید.");
  });

  it("does not disclose whether a forbidden record exists", () => {
    const message = getUserFacingErrorMessage({ status: 403 });

    expect(message).not.toMatch(/یافت نشد|وجود ندارد|حذف شده/);
  });

  it("names a bad report date range instead of the generic 400 text", () => {
    // The report API returns INVALID_DATE_RANGE as a 400. Translation has to win
    // over STATUS_MESSAGES[400], or the operator is told "check your input" with
    // no hint that it is the reporting period that is wrong.
    const message = getUserFacingErrorMessage(
      { status: 400, response: { data: { error: { message: "INVALID_DATE_RANGE" } } } },
      "خطا در بارگذاری گزارش فروش",
    );
    expect(message).toBe("بازه تاریخ انتخاب‌شده معتبر نیست؛ تاریخ شروع و پایان را بررسی کنید.");
  });

  it("falls back to the caller's message when nothing else is known", () => {
    expect(getUserFacingErrorMessage({}, "خطا در حذف دسته‌بندی")).toBe(
      "خطا در حذف دسته‌بندی",
    );
  });
});

describe("extractErrorStatus", () => {
  it("reads the status from an ApiError", () => {
    expect(extractErrorStatus({ status: 409 })).toBe(409);
  });

  it("reads the status from an axios-shaped error", () => {
    expect(extractErrorStatus({ response: { status: 500 } })).toBe(500);
  });

  it("returns undefined when there was no response at all", () => {
    expect(extractErrorStatus(new Error("Network error"))).toBeUndefined();
  });
});
