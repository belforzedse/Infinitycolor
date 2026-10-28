import { createClient } from "redis";
import { dispatchDueShippingSms } from "../../../jobs/dispatchShippingSms";
import { sendPatternSms } from "../../../services/sms/ippanel";
import type { SmsSendResult } from "../../../services/sms/types";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

jest.mock("../../../services/sms/ippanel", () => ({ sendPatternSms: jest.fn() }));
// setupStrapi boots the compiled app, while this job is imported from source.
// Both copies must stop at the same provider boundary.
jest.mock("../../../../dist/src/services/sms/ippanel", () =>
  jest.requireMock("../../../services/sms/ippanel"));

const migration = require("../../../../database/migrations/2026.10.23T10.00.00.add-delayed-shipping-sms.js");
const send = jest.mocked(sendPatternSms);
const redis = createClient() as any;
const claims = new Set<string>();
const DUE_AT = new Date("2026-10-23T12:00:00.000Z");
const SMS_ENV = {
  SMS_ENABLED: "false",
  IP_PANEL_API_URL: "https://sms.test.invalid/api/send",
  IP_PANEL_API_BASE_URL: "https://sms.test.invalid",
  IP_PANEL_API_KEY: "inert-integration-key",
  IP_PANEL_SENDER: "+983000000000",
  IP_PANEL_PATTERN_CODE: "inert-customer-pattern",
  IP_PANEL_PATTERN_SHIPPED: "inert-shipped-pattern",
};
const originalEnv = Object.fromEntries(Object.keys(SMS_ENV).map((key) => [key, process.env[key]]));

let strapi: any;
let f: Factories;
let fetchGuard: jest.SpyInstance;

beforeAll(async () => {
  fetchGuard = jest.spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Integration SMS test must not make HTTP requests"));
  Object.assign(process.env, SMS_ENV);
  strapi = await setupStrapi();
});

beforeEach(() => {
  Object.assign(process.env, SMS_ENV);
  f = makeFactories(strapi);
  fetchGuard.mockClear();
  claims.clear();
  send.mockReset().mockResolvedValue({ ok: true, messageId: "integration-shipping-sms" });
  redis.set.mockImplementation(async (key: string, _value: string, options?: { NX?: boolean }) => {
    if (options?.NX && claims.has(key)) return null;
    claims.add(key);
    return "OK";
  });
  redis.del.mockImplementation(async (key: string) => Number(claims.delete(key)));
});

afterEach(async () => {
  process.env.SMS_ENABLED = "false";
  await f.cleanup();
  expect(fetchGuard).not.toHaveBeenCalled();
});

afterAll(async () => {
  await teardownStrapi();
  fetchGuard.mockRestore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function scheduledOrder(barcode: string | null = "JEST_TEST__original_barcode") {
  // SMS stays disabled through all factory/lifecycle writes. Only the explicit
  // dispatcher invocation below enables the inert, mocked provider boundary.
  const user = await f.createUser({ phone: "09121112233" });
  const order = await f.createOrder({ status: "Shipment", userId: user.id });
  // The order-created lifecycle starts its notification asynchronously. Wait
  // for its real disabled audit so it cannot consume this test's Redis failure
  // or provider response after the scheduled dispatcher is enabled.
  // The deadline only bounds a hang: a loaded CI runner took over 2 s to settle,
  // and polling every tick added DB load of its own.
  const settleBy = Date.now() + 20_000;
  while (true) {
    const logs = await f.getOrderLogs(order.id);
    if (logs.some((log: any) => log.Changes?.type === "order_created" && log.Changes?.reason === "disabled")) break;
    if (Date.now() >= settleBy) throw new Error("Factory order-created notification did not settle while SMS was disabled");
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  await strapi.db.connection("orders").where({ id: order.id }).update({
    shipping_barcode: barcode,
    shipping_sms_due_at: DUE_AT,
    shipping_sms_last_attempt_at: null,
    shipping_sms_completed_at: null,
  });
  return order;
}

function dispatch(now = DUE_AT) {
  process.env.SMS_ENABLED = "true";
  return dispatchDueShippingSms(strapi, now);
}

function persisted(orderId: number) {
  return strapi.db.connection("orders").where({ id: orderId }).first();
}

async function shippingAudits(orderId: number) {
  const logs = await f.getOrderLogs(orderId);
  return logs.filter((log: any) => log.Changes?.channel === "sms" && log.Changes?.type === "shipped");
}

describe("delayed shipping SMS on real PostgreSQL", () => {
  it("preserves migration columns and the due index after schema boot and a migration replay", async () => {
    const columnNames = ["shipping_sms_due_at", "shipping_sms_completed_at", "shipping_sms_last_attempt_at"];
    const columns = await strapi.db.connection("information_schema.columns")
      .where({ table_schema: "public", table_name: "orders" })
      .whereIn("column_name", columnNames)
      .pluck("column_name");
    expect(columns.sort()).toEqual([...columnNames].sort());
    const index = () => strapi.db.connection("pg_indexes")
      .where({ schemaname: "public", tablename: "orders", indexname: "idx_orders_shipping_sms_due" })
      .first("indexname");
    expect(await index()).toEqual({ indexname: "idx_orders_shipping_sms_due" });

    const order = await scheduledOrder();
    const before = await persisted(order.id);
    await migration.up(strapi.db.connection);
    await migration.up(strapi.db.connection);
    expect(await persisted(order.id)).toEqual(before);
    expect(await index()).toEqual({ indexname: "idx_orders_shipping_sms_due" });
  });

  it("never sends before the due timestamp, then sends at the boundary with the latest barcode", async () => {
    const order = await scheduledOrder();
    expect(await dispatch(new Date(DUE_AT.getTime() - 1))).toEqual({ attempted: 0, completed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await persisted(order.id)).shipping_sms_last_attempt_at).toBeNull();

    await strapi.db.connection("orders").where({ id: order.id })
      .update({ shipping_barcode: "JEST_TEST__latest_barcode" });
    expect(await dispatch()).toEqual({ attempted: 1, completed: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      type: "shipped",
      phone: "09121112233",
      params: expect.objectContaining({ orderId: order.id, trackingCode: "JEST_TEST__latest_barcode" }),
    }));
    expect(new Date((await persisted(order.id)).shipping_sms_completed_at).toISOString()).toBe(DUE_AT.toISOString());
  });

  it("includes a dash when no tracking barcode exists", async () => {
    await scheduledOrder(null);
    expect(await dispatch()).toEqual({ attempted: 1, completed: 1 });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      params: expect.objectContaining({ trackingCode: "—" }),
    }));
  });

  it("does not send a pending notification after cancellation", async () => {
    const order = await scheduledOrder();
    await strapi.db.connection("orders").where({ id: order.id }).update({ status: "Cancelled" });

    expect(await dispatch()).toEqual({ attempted: 0, completed: 0 });
    expect(send).not.toHaveBeenCalled();
    expect((await persisted(order.id)).shipping_sms_completed_at).toBeNull();
  });

  it("lets concurrent scheduler ticks send one notification and persist one audit", async () => {
    const order = await scheduledOrder();
    let entered!: () => void;
    let release!: (result: SmsSendResult) => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const providerResult = new Promise<SmsSendResult>((resolve) => { release = resolve; });
    send.mockImplementationOnce(async () => {
      entered();
      return providerResult;
    });

    const first = dispatch();
    await providerEntered;
    let second;
    try {
      // The first tick holds the real PostgreSQL row lock while its provider
      // call is pending. The competing tick must skip that row immediately.
      second = await dispatch();
    } finally {
      release({ ok: true, messageId: "integration-concurrent-sms" });
    }
    expect(await first).toEqual({ attempted: 1, completed: 1 });
    expect(second).toEqual({ attempted: 0, completed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await shippingAudits(order.id)).toHaveLength(1);
    expect(await dispatch(new Date(DUE_AT.getTime() + 24 * 60 * 60 * 1000)))
      .toEqual({ attempted: 0, completed: 0 });
  }, 15_000);

  it("persists the successful audit through its order FK while the dispatcher owns the row lock", async () => {
    const order = await scheduledOrder();
    const foreignKeys = await strapi.db.connection.raw(`
      SELECT conname FROM pg_constraint
       WHERE contype = 'f'
         AND conrelid = 'order_logs_order_links'::regclass
         AND confrelid = 'orders'::regclass
    `);
    expect(foreignKeys.rows).toHaveLength(1);

    expect(await dispatch()).toEqual({ attempted: 1, completed: 1 });
    const audits = await shippingAudits(order.id);
    expect(audits).toHaveLength(1);
    expect(audits[0].Changes).toEqual(expect.objectContaining({
      outcome: "sent", messageId: "integration-shipping-sms", type: "shipped",
    }));
    const relation = await strapi.db.connection("order_logs_order_links")
      .where({ order_id: order.id, order_log_id: audits[0].id }).first();
    expect(relation).toBeDefined();
  }, 15_000);

  it("keeps the timer pending when Redis cannot claim idempotency", async () => {
    const order = await scheduledOrder();
    redis.set.mockRejectedValue(new Error("integration Redis unavailable"));

    expect(await dispatch()).toEqual({ attempted: 1, completed: 0 });
    expect(send).not.toHaveBeenCalled();
    const pending = await persisted(order.id);
    expect(pending.shipping_sms_completed_at).toBeNull();
    expect(pending.shipping_sms_last_attempt_at).toBeNull();
  });

  it("retries a known provider rejection only after the five-minute retry interval", async () => {
    const order = await scheduledOrder();
    send.mockResolvedValueOnce({ ok: false, status: 400 });

    expect(await dispatch()).toEqual({ attempted: 1, completed: 0 });
    const rejected = await persisted(order.id);
    expect(rejected.shipping_sms_completed_at).toBeNull();
    expect(new Date(rejected.shipping_sms_last_attempt_at).toISOString()).toBe(DUE_AT.toISOString());
    expect(await dispatch(new Date(DUE_AT.getTime() + 5 * 60 * 1000 - 1)))
      .toEqual({ attempted: 0, completed: 0 });
    expect(send).toHaveBeenCalledTimes(1);

    const retriedAt = new Date(DUE_AT.getTime() + 5 * 60 * 1000);
    expect(await dispatch(retriedAt)).toEqual({ attempted: 1, completed: 1 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Date((await persisted(order.id)).shipping_sms_completed_at).toISOString())
      .toBe(retriedAt.toISOString());
  });

  it("records a provider timeout once and does not automatically resend the uncertain submission", async () => {
    const order = await scheduledOrder();
    send.mockResolvedValueOnce({ ok: false, reason: "timeout" });

    expect(await dispatch()).toEqual({ attempted: 1, completed: 1 });
    expect((await persisted(order.id)).shipping_sms_completed_at).not.toBeNull();
    expect(await dispatch(new Date(DUE_AT.getTime() + 24 * 60 * 60 * 1000)))
      .toEqual({ attempted: 0, completed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    expect((await shippingAudits(order.id))[0].Changes).toEqual(expect.objectContaining({
      outcome: "failed", reason: "timeout",
    }));
  });
});
