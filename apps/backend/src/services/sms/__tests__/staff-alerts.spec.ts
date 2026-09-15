import { RedisClient } from "../../../index";
import { OrderNotReadyError, notifyStaffOrderStartedSms } from "../staff-alerts";

const createResponse = (status: number, body: unknown) =>
  ({
    status,
    text: jest.fn().mockResolvedValue(typeof body === "string" ? body : JSON.stringify(body)),
  }) as any;

const OK_BODY = { meta: { status: true }, data: { message_outbox_ids: [42] } };

type StrapiStub = ReturnType<typeof createStrapi>;

function createStrapi(options: {
  order?: any;
  alertSetting?: any;
}) {
  const orderLogCreate = jest.fn().mockResolvedValue({});
  return {
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    },
    entityService: {
      findOne: jest.fn().mockResolvedValue(options.order ?? null),
    },
    db: {
      query: jest.fn((uid: string) => {
        if (uid === "api::order-alert-setting.order-alert-setting") {
          return { findOne: jest.fn().mockResolvedValue(options.alertSetting ?? null) };
        }
        return { create: orderLogCreate };
      }),
    },
    orderLogCreate,
  };
}

function orderLogPayload(strapi: StrapiStub) {
  return strapi.orderLogCreate.mock.calls[0]?.[0]?.data?.Changes;
}

const STARTED_ORDER = {
  id: 501,
  Status: "Started",
  contract: { Amount: 1_250_000 },
  delivery_address: { FullName: "زهرا محمدی", Phone: "+989123381098" },
};

const TWO_RECIPIENTS = {
  id: 1,
  enabled: true,
  recipients: [
    { label: "انبار", phone: "09121234567", enabled: true },
    { label: "پشتیبانی", phone: "09129876543", enabled: true },
  ],
};

describe("staff order alerts", () => {
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SMS_ENABLED: "true",
      IP_PANEL_API_KEY: "test-api-key",
      IP_PANEL_SENDER: "+983000505",
      IP_PANEL_PATTERN_STAFF_ORDER_STARTED: "staff-pattern-code",
    };
    global.fetch = jest.fn().mockResolvedValue(createResponse(200, OK_BODY)) as any;
    const redis: any = await RedisClient;
    redis.set.mockReset().mockResolvedValue("OK");
    redis.del.mockReset().mockResolvedValue(1);
  });

  afterAll(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
  });

  it("sends one SMS per enabled recipient and records a single order log", async () => {
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.ok).toBe(true);
    expect(result.sent).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(strapi.orderLogCreate).toHaveBeenCalledTimes(1);

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.code).toBe("staff-pattern-code");
    expect(payload.recipients).toEqual(["+989121234567"]);
    expect(payload.params).toEqual({
      orderId: "501",
      amount: "1,250,000",
      customer: "زهرا محمدی",
      phone: "09123381098",
    });

    expect(orderLogPayload(strapi).recipients).toEqual([
      { recipient: "+98****4567", outcome: "sent", messageId: 42 },
      { recipient: "+98****6543", outcome: "sent", messageId: 42 },
    ]);
  });

  it("throws so BullMQ retries while the settlement transaction is uncommitted", async () => {
    const strapi = createStrapi({
      order: { ...STARTED_ORDER, Status: "Paying" },
      alertSetting: TWO_RECIPIENTS,
    });

    await expect(notifyStaffOrderStartedSms(strapi as any, { orderId: 501 })).rejects.toThrow(
      OrderNotReadyError,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("throws rather than completing when the order is not readable yet", async () => {
    // A completed skip would retire the stable job id for 24h and lose the alert
    // for a manual order enqueued from inside its own insert transaction.
    const strapi = createStrapi({ order: null, alertSetting: TWO_RECIPIENTS });

    await expect(notifyStaffOrderStartedSms(strapi as any, { orderId: 501 })).rejects.toThrow(
      OrderNotReadyError,
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it.each(["Done", "Shipment", "Cancelled"])(
    "skips permanently when the order has moved on to %s",
    async (status) => {
      const strapi = createStrapi({
        order: { ...STARTED_ORDER, Status: status },
        alertSetting: TWO_RECIPIENTS,
      });

      const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

      expect(result).toEqual({ ok: false, skipped: true, reason: "status_not_started" });
      expect(global.fetch).not.toHaveBeenCalled();
    },
  );

  it("skips when the alert is switched off", async () => {
    const strapi = createStrapi({
      order: STARTED_ORDER,
      alertSetting: { ...TWO_RECIPIENTS, enabled: false },
    });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.reason).toBe("no_recipients");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("skips when the single type has never been saved", async () => {
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: null });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.reason).toBe("no_recipients");
  });

  it("uses the pinned staff template when no override is configured", async () => {
    // Pinned in config.ts so a fresh deploy alerts without an env change.
    delete process.env.IP_PANEL_PATTERN_STAFF_ORDER_STARTED;
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.code).toBe("yk33tn38qf9jsi7");
  });

  it("never borrows the customer template, even with the override blanked", async () => {
    process.env.IP_PANEL_PATTERN_STAFF_ORDER_STARTED = "";
    process.env.IP_PANEL_PATTERN_CODE = "customer-pattern-code";
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.code).toBe("yk33tn38qf9jsi7");
    expect(payload.code).not.toBe("customer-pattern-code");
  });

  it("honours an explicit pattern override", async () => {
    process.env.IP_PANEL_PATTERN_STAFF_ORDER_STARTED = "override-code";
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.code).toBe("override-code");
  });

  it("drops an invalid number without blocking the rest of the list", async () => {
    const strapi = createStrapi({
      order: STARTED_ORDER,
      alertSetting: {
        id: 1,
        enabled: true,
        recipients: [
          { label: "ثابت", phone: "02112345678", enabled: true },
          { label: "انبار", phone: "09121234567", enabled: true },
        ],
      },
    });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.sent).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores recipients whose row is disabled", async () => {
    const strapi = createStrapi({
      order: STARTED_ORDER,
      alertSetting: {
        id: 1,
        enabled: true,
        recipients: [
          { label: "انبار", phone: "09121234567", enabled: false },
          { label: "پشتیبانی", phone: "09129876543", enabled: true },
        ],
      },
    });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.sent).toBe(1);
    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.recipients).toEqual(["+989129876543"]);
  });

  it("skips a recipient whose idempotency marker already exists", async () => {
    const redis: any = await RedisClient;
    redis.set.mockResolvedValueOnce(null).mockResolvedValueOnce("OK");
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.sent).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(orderLogPayload(strapi).recipients[0]).toEqual({
      recipient: "+98****4567",
      outcome: "skipped",
      reason: "duplicate",
    });
  });

  it("still sends when Redis is unreachable rather than reporting a duplicate", async () => {
    const redis: any = await RedisClient;
    redis.set.mockRejectedValue(new Error("ECONNREFUSED"));
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.sent).toBe(2);
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(strapi.log.warn).toHaveBeenCalledWith(
      "[sms] staff alert idempotency store unavailable; sending anyway",
      expect.objectContaining({ orderId: 501 }),
    );
  });

  it("releases the marker and reports a failure when the provider rejects", async () => {
    const redis: any = await RedisClient;
    (global.fetch as jest.Mock).mockResolvedValue(
      createResponse(500, { meta: { status: false, message: "boom" } }),
    );
    const strapi = createStrapi({
      order: STARTED_ORDER,
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.ok).toBe(false);
    expect(result.sent).toBe(0);
    expect(redis.del).toHaveBeenCalledTimes(1);
    expect(orderLogPayload(strapi).recipients[0].outcome).toBe("failed");
  });

  it("fills every pattern slot even when the order has no name or contract", async () => {
    // A variable declared at IPPanel but not supplied leaves a hole in the
    // delivered message, so these must never be dropped.
    const strapi = createStrapi({
      order: { id: 502, Status: "Started" },
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 502 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.params).toEqual({
      orderId: "502",
      amount: "نامشخص",
      customer: "نامشخص",
      phone: "نامشخص",
    });
  });

  it("never sends the phone number as the customer name", async () => {
    // OTP signup stores the phone in `username`, so it must not be a name source.
    const strapi = createStrapi({
      order: {
        id: 504,
        Status: "Started",
        contract: { Amount: 90000 },
        user: { username: "+989121234567", phone: "+989121234567", user_info: null },
      },
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 504 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.params.customer).toBe("نامشخص");
    // It is still available, but only under its own clearly-labelled slot.
    expect(payload.params.phone).toBe("09121234567");
  });

  it("falls back to the profile name when there is no delivery address", async () => {
    const strapi = createStrapi({
      order: {
        id: 503,
        Status: "Started",
        contract: { Amount: 90000 },
        user: {
          username: "+989121234567",
          phone: "+989121234567",
          user_info: { FirstName: "علی", LastName: "رضایی" },
        },
      },
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 503 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.params).toEqual({
      orderId: "503",
      amount: "90,000",
      customer: "علی رضایی",
      phone: "09121234567",
    });
  });

  it.each([
    ["+989123381098", "09123381098"],
    ["989123381098", "09123381098"],
    ["09123381098", "09123381098"],
    ["۰۹۱۲۳۳۸۱۰۹۸", "09123381098"],
    ["0912 338 1098", "09123381098"],
    ["02112345678", "02112345678"],
  ])("renders the contact number %s as %s", async (stored, expected) => {
    const strapi = createStrapi({
      order: { ...STARTED_ORDER, delivery_address: { Phone: stored } },
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.params.phone).toBe(expected);
  });

  it("falls back to the account phone when the address has none", async () => {
    const strapi = createStrapi({
      order: {
        ...STARTED_ORDER,
        delivery_address: { FullName: "زهرا محمدی" },
        user: { phone: "+989121112233" },
      },
      alertSetting: { id: 1, enabled: true, recipients: [TWO_RECIPIENTS.recipients[0]] },
    });

    await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    const payload = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
    expect(payload.params.phone).toBe("09121112233");
  });

  it("skips when SMS is globally disabled", async () => {
    process.env.SMS_ENABLED = "false";
    const strapi = createStrapi({ order: STARTED_ORDER, alertSetting: TWO_RECIPIENTS });

    const result = await notifyStaffOrderStartedSms(strapi as any, { orderId: 501 });

    expect(result.reason).toBe("disabled");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
