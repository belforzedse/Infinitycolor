import { RedisClient } from "../../../index";
import { loadSmsConfig } from "../config";
import { buildSmsIdempotencyKey } from "../idempotency";
import {
  buildLegacyOtpPayload,
  buildPatternPayload,
  sendLegacyOtpSms,
  sendPatternSms,
} from "../ippanel";
import {
  buildOrderNotificationParams,
  formatCancellationReasonForSms,
  formatOrderStatusForSms,
  notifyOrderStatusSms,
} from "../notifications";
import { normalizeIranMobile } from "../phone";
import { maskPhone, maskSecret } from "../redaction";

const createResponse = (status: number, body: unknown) =>
  ({
    status,
    text: jest.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  }) as any;

describe("sms service", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = { ...originalEnv, SMS_ENABLED: "false" };
    global.fetch = jest.fn() as any;
    const redis: any = await RedisClient;
    redis.set.mockReset();
    redis.del.mockReset();
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it.each([
    ["09123456789", "+989123456789"],
    ["989123456789", "+989123456789"],
    ["+989123456789", "+989123456789"],
    ["۹۱۲۳۴۵۶۷۸۹", "+989123456789"],
    ["٠٩١٢٣٤٥٦٧٨٩", "+989123456789"],
  ])("normalizes Iranian mobile number %s", (input, expected) => {
    expect(normalizeIranMobile(input)).toBe(expected);
  });

  it.each(["02112345678", "1234", "+981212345678", "abc09123456789"])(
    "rejects invalid mobile number %s",
    (input) => {
      expect(normalizeIranMobile(input)).toBeNull();
    },
  );

  it("loads disabled config by default and composes the Edge endpoint", () => {
    const config = loadSmsConfig({
      IP_PANEL_API_KEY: "secret",
      IP_PANEL_PATTERN_CODE: "pattern",
      IP_PANEL_SENDER: "+983000505",
    });

    expect(config.enabled).toBe(false);
    expect(config.apiUrl).toBe("https://edge.ippanel.com/v1/api/send");
  });

  it("supports a full IP_PANEL_API_URL override", () => {
    const config = loadSmsConfig({
      SMS_ENABLED: "true",
      IP_PANEL_API_URL: "https://legacy.example.test/send",
      IP_PANEL_API_BASE_URL: "https://edge.ippanel.com/v1",
      IP_PANEL_PATTERN_ENDPOINT: "/api/send",
    });

    expect(config.enabled).toBe(true);
    expect(config.apiUrl).toBe("https://legacy.example.test/send");
  });

  it("builds the IPPanel Edge pattern payload", () => {
    expect(
      buildPatternPayload({
        sender: "+983000505",
        patternCode: "pattern",
        recipient: "+989123456789",
        params: { code: "123456", orderId: 42, empty: undefined },
      }),
    ).toEqual({
      sending_type: "pattern",
      from_number: "+983000505",
      code: "pattern",
      recipients: ["+989123456789"],
      params: { code: "123456", orderId: "42" },
    });
  });

  it("builds the legacy IPPanel OTP payload", () => {
    expect(
      buildLegacyOtpPayload({
        sender: "+983000505",
        patternCode: "otp-pattern",
        recipient: "+989123456789",
        code: "123456",
      }),
    ).toEqual({
      recipient: "+989123456789",
      code: "otp-pattern",
      sender: "+983000505",
      variable: {
        "verification-code": "123456",
      },
    });
  });

  it("does not call fetch when SMS is disabled", async () => {
    const result = await sendPatternSms({
      type: "otp",
      phone: "09123456789",
      params: { code: "123456" },
      config: loadSmsConfig({ SMS_ENABLED: "false" }),
    });

    expect(result).toMatchObject({ ok: false, disabled: true, skipped: true });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("sends Persian params to IPPanel with Authorization header", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      createResponse(200, {
        data: { message_outbox_ids: [1123594208] },
        meta: { status: true, message: "Success", message_code: "200-1" },
      }),
    );

    const result = await sendPatternSms({
      type: "order_status_updated",
      phone: "09123456789",
      params: { code: "پرداخت", orderId: 42 },
      config: loadSmsConfig({
        SMS_ENABLED: "true",
        IP_PANEL_API_KEY: "secret-key",
        IP_PANEL_PATTERN_CODE: "pattern",
        IP_PANEL_SENDER: "+983000505",
      }),
    });

    expect(result).toMatchObject({ ok: true, messageId: 1123594208 });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://edge.ippanel.com/v1/api/send",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "secret-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sending_type: "pattern",
          from_number: "+983000505",
          code: "pattern",
          recipients: ["+989123456789"],
          params: { code: "پرداخت", orderId: "42" },
        }),
      }),
    );
  });

  it("sends OTP through the legacy IPPanel endpoint with apiKey header", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      createResponse(200, {
        success: true,
        messageId: 1123594209,
      }),
    );

    const result = await sendLegacyOtpSms({
      phone: "09123456789",
      code: "123456",
      config: loadSmsConfig({
        SMS_ENABLED: "true",
        IP_PANEL_API_URL: "https://edge-override.example.test/api/send",
        IP_PANEL_API_KEY: "secret-key",
        IP_PANEL_PATTERN_CODE: "otp-pattern",
        IP_PANEL_SENDER: "+983000505",
      }),
    });

    expect(result).toMatchObject({ ok: true, messageId: 1123594209 });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api2.ippanel.com/api/v1/sms/pattern/normal/send",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apiKey: "secret-key",
        },
        body: JSON.stringify({
          recipient: "+989123456789",
          code: "otp-pattern",
          sender: "+983000505",
          variable: {
            "verification-code": "123456",
          },
        }),
      }),
    );
  });

  it("never logs raw OTP delivery identifiers even if the provider echoes them", async () => {
    const logger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    (global.fetch as jest.Mock).mockResolvedValue(
      createResponse(502, {
        meta: {
          status: false,
          message: "09123456789 654321",
          message_code: "PROVIDER_REJECTED",
        },
      }),
    );

    await sendLegacyOtpSms({
      phone: "09123456789",
      code: "654321",
      logger,
      config: loadSmsConfig({
        SMS_ENABLED: "true",
        IP_PANEL_API_KEY: "secret-key",
        IP_PANEL_PATTERN_CODE: "otp-pattern",
        IP_PANEL_SENDER: "+983000505",
      }),
    });

    const logs = JSON.stringify([
      ...logger.debug.mock.calls,
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logs).not.toContain("09123456789");
    expect(logs).not.toContain("+989123456789");
    expect(logs).not.toContain("654321");
    expect(logger.warn).toHaveBeenCalledWith(
      "[sms] IPPanel legacy OTP SMS failed",
      expect.objectContaining({ recipient: "+98****6789" }),
    );
  });

  it("returns non-throwing failure results for provider and request failures", async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce(
      createResponse(200, { meta: { status: false, message: "Invalid pattern" } }),
    );

    const config = loadSmsConfig({
      SMS_ENABLED: "true",
      IP_PANEL_API_KEY: "secret-key",
      IP_PANEL_PATTERN_CODE: "pattern",
      IP_PANEL_SENDER: "+983000505",
    });

    await expect(
      sendPatternSms({
        type: "order_status_updated",
        phone: "09123456789",
        params: { code: "42" },
        config,
      }),
    ).resolves.toMatchObject({ ok: false, status: 200 });

    (global.fetch as jest.Mock).mockRejectedValueOnce({ name: "AbortError" });
    await expect(
      sendPatternSms({
        type: "order_status_updated",
        phone: "09123456789",
        params: { code: "42" },
        config,
      }),
    ).resolves.toMatchObject({ ok: false, reason: "timeout" });
  });

  it("masks secrets and phone numbers in logs", () => {
    expect(maskSecret("1234567890abcdef")).toBe("1234...cdef");
    expect(maskPhone("+989123456789")).toBe("+98****6789");
  });

  it("maps internal order statuses to customer-facing Persian SMS labels", () => {
    expect(formatOrderStatusForSms("Started")).toBe("پرداخت شده و در حال آماده‌سازی");
    expect(formatOrderStatusForSms("Shipment")).toBe("ارسال شده");
    // `Done` precedes `Shipment` in the fulfilment chain, so it reads as
    // "completed", not "delivered" — otherwise the customer is told the order
    // arrived before they are told it shipped.
    expect(formatOrderStatusForSms("Done")).toBe("تکمیل شده");
    expect(formatOrderStatusForSms("Cancelled")).toBe("لغو شده");
  });

  it("maps cancellation reasons to customer-facing Persian SMS labels", () => {
    expect(formatCancellationReasonForSms("out_of_stock")).toBe("ناموجود بودن کالا");
    expect(formatCancellationReasonForSms("payment failed")).toBe("تکمیل نشدن پرداخت");
    expect(formatCancellationReasonForSms("admin_cancelled")).toBe("لغو توسط پشتیبانی");
    expect(formatCancellationReasonForSms()).toBe("لغو سفارش توسط پشتیبانی");
    expect(formatCancellationReasonForSms("بر اساس درخواست شما")).toBe("بر اساس درخواست شما");
    expect(formatCancellationReasonForSms("SOME_INTERNAL_CODE")).toBe("لغو سفارش توسط پشتیبانی");
  });

  it("uses a caller-supplied fallback reason code instead of the generic support default", () => {
    // No reason at all: falls back to the given code's label, not the hardcoded default.
    expect(formatCancellationReasonForSms(undefined, "payment_gateway_declined")).toBe(
      "پرداخت توسط درگاه تایید نشد",
    );
    // An unmapped internal-looking code: also falls back to the given code, not the default.
    expect(
      formatCancellationReasonForSms("provider_terminal_status", "payment_gateway_declined"),
    ).toBe("پرداخت توسط درگاه تایید نشد");
    // A mapped code still wins over the fallback.
    expect(formatCancellationReasonForSms("out_of_stock", "payment_gateway_declined")).toBe(
      "ناموجود بودن کالا",
    );
    // Genuine human-typed free text still passes through unchanged, fallback or not.
    expect(
      formatCancellationReasonForSms("مشتری تماس گرفت و لغو کرد", "payment_gateway_declined"),
    ).toBe("مشتری تماس گرفت و لغو کرد");
    // An unrecognized fallback code degrades to the original hardcoded default.
    expect(formatCancellationReasonForSms(undefined, "not_a_real_code")).toBe(
      "لغو سفارش توسط پشتیبانی",
    );
  });

  it("builds SMS params without leaking internal status or extra reason fields", () => {
    expect(
      buildOrderNotificationParams({
        orderId: 42,
        status: "Started",
        amount: 1000,
      }),
    ).toEqual({
      code: 42,
      orderId: 42,
      status: "پرداخت شده و در حال آماده‌سازی",
      trackingCode: undefined,
      amount: 1000,
      reason: undefined,
    });

    expect(
      buildOrderNotificationParams({
        orderId: 42,
        status: "Cancelled",
        reason: "out_of_stock",
      }),
    ).toMatchObject({
      status: "لغو شده",
      reason: "ناموجود بودن کالا",
    });
  });

  it("claims idempotency before sending order notifications", async () => {
    const redis: any = await RedisClient;
    redis.set.mockResolvedValueOnce("OK").mockResolvedValueOnce(null);
    (global.fetch as jest.Mock).mockResolvedValue(
      createResponse(200, { meta: { status: true, message_code: "200-1" } }),
    );
    process.env.SMS_ENABLED = "true";
    process.env.IP_PANEL_API_KEY = "secret-key";
    process.env.IP_PANEL_PATTERN_CODE = "pattern";
    process.env.IP_PANEL_SENDER = "+983000505";

    const strapi: any = {
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          id: 10,
          Status: "Started",
          user: { id: 5, phone: "09123456789" },
          contract: { Amount: 1000 },
        }),
      },
    };

    await expect(
      notifyOrderStatusSms(strapi, {
        orderId: 10,
        oldStatus: "Paying",
        newStatus: "Started",
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      notifyOrderStatusSms(strapi, {
        orderId: 10,
        oldStatus: "Paying",
        newStatus: "Started",
      }),
    ).resolves.toMatchObject({ duplicate: true, skipped: true });

    expect(redis.set).toHaveBeenCalledWith(
      buildSmsIdempotencyKey({
        type: "order_status_updated",
        orderId: 10,
        userId: 5,
        fingerprint: "Paying-Started-none",
      }),
      "1",
      expect.objectContaining({ NX: true }),
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("persists a customer-visible notification outcome for operational follow-up", async () => {
    process.env.SMS_ENABLED = "false";
    const createOrderLog = jest.fn().mockResolvedValue({ id: 1 });
    const strapi: any = {
      log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
      entityService: {
        findOne: jest.fn().mockResolvedValue({
          id: 11,
          Status: "Shipment",
          user: { id: 6, phone: "09123456789" },
          contract: { Amount: 2000 },
        }),
      },
      db: {
        query: jest.fn(() => ({ create: createOrderLog })),
      },
    };

    await expect(
      notifyOrderStatusSms(strapi, {
        orderId: 11,
        oldStatus: "Started",
        newStatus: "Shipment",
        trackingCode: "TRACK-11",
      }),
    ).resolves.toMatchObject({
      ok: false,
      skipped: true,
      disabled: true,
      reason: "disabled",
    });

    expect(createOrderLog).toHaveBeenCalledWith({
      data: expect.objectContaining({
        order: 11,
        Description: "Customer SMS delivery outcome",
        Changes: expect.objectContaining({
          channel: "sms",
          type: "shipped",
          outcome: "skipped",
          reason: "disabled",
          recipient: "091****6789",
        }),
      }),
    });
  });
});
