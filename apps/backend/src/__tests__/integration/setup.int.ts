/**
 * setupFilesAfterEnv for the backend integration layer (runs per test file,
 * before the test module is imported).
 *
 * The DATABASE / persistence / business logic stays REAL. We mock ONLY external
 * providers so tests never hit the network and never need real credentials.
 * Mocks are registered here (before Strapi is required in a test's beforeAll),
 * so when Strapi's compiled `dist` requires these modules it gets the mocks.
 */
/// <reference types="jest" />

// Inert credentials for any provider code that reads env at module load.
process.env.MELLAT_TERMINAL_ID = process.env.MELLAT_TERMINAL_ID || "test-terminal-id";
process.env.MELLAT_USERNAME = process.env.MELLAT_USERNAME || "test-username";
process.env.MELLAT_PASSWORD = process.env.MELLAT_PASSWORD || "test-password";
// Always overwrite inherited/local values: integration tests must never use
// developer, staging, or production SnappPay endpoints or credentials.
process.env.SNAPPAY_BASE_URL = "https://snappay.test.invalid";
process.env.SNAPPAY_CLIENT_ID = "test-snappay-client-id";
process.env.SNAPPAY_CLIENT_SECRET = "test-snappay-secret";
process.env.SNAPPAY_USERNAME = "test-snappay-username";
process.env.SNAPPAY_PASSWORD = "test-snappay-password";
process.env.SNAPPAY_RETURN_URL =
  "https://storefront.test.invalid/api/snapp/return";
process.env.SNAPPAY_HARDENED_INITIATION_ENABLED = "true";
process.env.SMS_ENABLED = "false";
process.env.ZARINPAL_MERCHANT_ID = process.env.ZARINPAL_MERCHANT_ID || "00000000-0000-0000-0000-000000000000";

// --- External providers: MOCKED (never our own persistence/business logic) ---

// Redis: the app entry (src/index.ts) creates a client and .connect()s at import time.
jest.mock("redis", () => {
  const client: any = {
    on: jest.fn(() => client),
    connect: jest.fn(async () => client),
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    exists: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
    getDel: jest.fn(),
    quit: jest.fn(async () => undefined),
    scanIterator: jest.fn(async function* () {}),
  };
  return { createClient: jest.fn(() => client) };
});

// ioredis is used by strapi-plugin-redis / rest-cache. Without this it tries to
// reach a real Redis and floods NOAUTH errors / leaks a connection handle.
jest.mock("ioredis", () => {
  class RedisMock {
    on() {
      return this;
    }
    once() {
      return this;
    }
    connect() {
      return Promise.resolve();
    }
    get() {
      return Promise.resolve(null);
    }
    set() {
      return Promise.resolve("OK");
    }
    del() {
      return Promise.resolve(0);
    }
    quit() {
      return Promise.resolve("OK");
    }
    disconnect() {
      return undefined;
    }
    defineCommand() {
      return undefined;
    }
  }
  return { __esModule: true, default: RedisMock, Redis: RedisMock };
});

// HTTP client used by SnappPay / SMS / shipping providers.
jest.mock("axios");

// Frontend/CDN revalidation trigger — external boundary, no network in tests.
// Keyed by resolved absolute path, so every relative importer gets this mock.
jest.mock("../../utils/revalidate", () => ({
  triggerFrontendRevalidation: jest.fn(async () => undefined),
}));

// Payment SDKs — no network, no real gateways.
jest.mock("mellat-checkout", () =>
  jest.fn().mockImplementation(() => ({
    paymentRequest: jest.fn(),
    verifyPayment: jest.fn(),
  })),
);

jest.mock("zarinpal-node-sdk", () =>
  jest.fn().mockImplementation(() => ({
    payments: { create: jest.fn(), verify: jest.fn() },
  })),
);

// Generous timeout: the first real Strapi boot also runs schema migrations
// against a fresh Postgres, which can take a couple of minutes on cold Docker.
jest.setTimeout(240_000);
