jest.mock("../../../utils/e2eFixturesIdToken", () => ({ verifyE2EFixturesIdToken: jest.fn() }));

jest.mock("../services/e2e-fixture", () => {
  class E2EFixtureError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message = code,
    ) {
      super(message);
    }
  }
  return {
    E2EFixtureError,
    provisionShopper: jest.fn(),
    readSlotStock: jest.fn(),
    cleanupShopper: jest.fn(),
    setSlotProductPublished: jest.fn(),
  };
});

import routes from "../routes/e2e-fixture";
import requireFixtureToken from "../middlewares/require-fixture-token";
import controller from "../controllers/e2e-fixture";
import * as service from "../services/e2e-fixture";
import { verifyE2EFixturesIdToken } from "../../../utils/e2eFixturesIdToken";

const TOKEN = "k".repeat(40);
const originalEnv = { ...process.env };

function ctxWith(overrides: Record<string, unknown> = {}): any {
  return { request: { headers: {}, body: {} }, params: {}, path: "/api/e2e-fixtures/shoppers", ...overrides };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env = {
    ...originalEnv,
    E2E_FIXTURES_ENABLED: "true",
    E2E_FIXTURES_TOKEN: TOKEN,
    FRONTEND_URL: "https://staging.infinitycolor.co",
  };
});

afterAll(() => {
  process.env = originalEnv;
});

describe("e2e fixture routes", () => {
  it("are unauthenticated at Strapi level but every one requires the fixture token", () => {
    expect(routes.routes).toHaveLength(4);
    for (const route of routes.routes) {
      expect(route.config.auth).toBe(false);
      expect(route.config.middlewares).toEqual(["api::e2e-fixture.require-fixture-token"]);
    }
  });
});

describe("require-fixture-token", () => {
  const log = { warn: jest.fn() };
  const run = async (headers: Record<string, string>) => {
    const ctx = ctxWith({ request: { headers, body: {} } });
    const next = jest.fn();
    await requireFixtureToken({}, { strapi: { log } })(ctx, next);
    return { ctx, next };
  };
  const useGitLab = () => {
    Object.assign(process.env, {
      E2E_FIXTURES_OIDC_ISSUER: "https://git.alpagency.net",
      E2E_FIXTURES_OIDC_AUDIENCE: "https://api.staging.infinitycolor.co",
      E2E_FIXTURES_OIDC_PROJECT: "bel4/infinity",
      E2E_FIXTURES_OIDC_ENVIRONMENT: "staging",
    });
  };

  it("passes a request carrying the configured token", async () => {
    const { next } = await run({ "x-e2e-fixtures-token": TOKEN });
    expect(next).toHaveBeenCalled();
  });

  it("answers 404 for a missing or wrong token", async () => {
    for (const headers of [{}, { "x-e2e-fixtures-token": "wrong" }]) {
      const { ctx, next } = await run(headers);
      expect(ctx.status).toBe(404);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("answers 404 wherever fixtures are not enabled, even with the right token", async () => {
    delete process.env.E2E_FIXTURES_ENABLED;
    const { ctx, next } = await run({ "x-e2e-fixtures-token": TOKEN });
    expect(ctx.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("answers 404 on a backend wired to the production storefront", async () => {
    process.env.FRONTEND_URL = "https://infinitycolor.co";
    const { ctx, next } = await run({ "x-e2e-fixtures-token": TOKEN });
    expect(ctx.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
  });

  it("passes a GitLab ID token the verifier accepts, with no static token configured", async () => {
    delete process.env.E2E_FIXTURES_TOKEN;
    useGitLab();
    (verifyE2EFixturesIdToken as jest.Mock).mockResolvedValue({ ok: true, job: "8461" });
    const { next } = await run({ "x-e2e-fixtures-id-token": "jwt" });
    expect(next).toHaveBeenCalled();
    expect(verifyE2EFixturesIdToken).toHaveBeenCalledWith("jwt", expect.objectContaining({ project: "bel4/infinity" }));
  });

  it("answers 404 and logs why for an ID token the verifier refuses", async () => {
    useGitLab();
    (verifyE2EFixturesIdToken as jest.Mock).mockResolvedValue({ ok: false, reason: "environment" });
    const { ctx, next } = await run({ "x-e2e-fixtures-id-token": "jwt" });
    expect(ctx.status).toBe(404);
    expect(next).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("[e2e-fixture] refused a GitLab ID token: environment");
  });

  it("never checks an ID token where GitLab ID tokens are not configured, or on production", async () => {
    const { ctx } = await run({ "x-e2e-fixtures-id-token": "jwt" });
    expect(ctx.status).toBe(404);
    useGitLab();
    process.env.FRONTEND_URL = "https://infinitycolor.co";
    const onProduction = await run({ "x-e2e-fixtures-id-token": "jwt" });
    expect(onProduction.ctx.status).toBe(404);
    expect(verifyE2EFixturesIdToken).not.toHaveBeenCalled();
  });
});

describe("e2e fixture controller", () => {
  it.each([undefined, -1, 64, 2.5, "3"])("rejects slot %p", async (slot) => {
    const ctx = ctxWith({ request: { headers: {}, body: { slot } } });
    await controller.provision(ctx);
    expect(ctx.status).toBe(400);
    expect(ctx.body.error).toBe("E2E_FIXTURE_SLOT_INVALID");
    expect(service.provisionShopper).not.toHaveBeenCalled();
  });

  it("rejects a negative or fractional wallet amount", async () => {
    for (const walletToman of [-1, 1.5, "100"]) {
      const ctx = ctxWith({ request: { headers: {}, body: { slot: 1, walletToman } } });
      await controller.provision(ctx);
      expect(ctx.status).toBe(400);
      expect(ctx.body.error).toBe("E2E_FIXTURE_WALLET_INVALID");
    }
  });

  it("provisions with a zero wallet by default", async () => {
    (service.provisionShopper as jest.Mock).mockResolvedValue({ slot: 4 });
    const ctx = ctxWith({ request: { headers: {}, body: { slot: 4 } } });
    await controller.provision(ctx);
    expect(service.provisionShopper).toHaveBeenCalledWith(expect.anything(), { slot: 4, walletToman: 0 });
    expect(ctx.body).toEqual({ data: { slot: 4 } });
  });

  it("maps fixture errors to their status and code", async () => {
    (service.readSlotStock as jest.Mock).mockRejectedValue(
      new (service as any).E2EFixtureError("E2E_FIXTURE_SLOT_UNPROVISIONED", 404, "slot 5 has no product yet"),
    );
    const ctx = ctxWith({ params: { slot: "5" } });
    await controller.stock(ctx);
    expect(ctx.status).toBe(404);
    expect(ctx.body).toEqual({ error: "E2E_FIXTURE_SLOT_UNPROVISIONED", message: "slot 5 has no product yet" });
  });

  it("validates the route slot and the publish flag", async () => {
    const badSlot = ctxWith({ params: { slot: "07x" } });
    await controller.cleanup(badSlot);
    expect(badSlot.status).toBe(400);

    const badFlag = ctxWith({ params: { slot: "7" }, request: { headers: {}, body: { published: "no" } } });
    await controller.product(badFlag);
    expect(badFlag.status).toBe(400);
    expect(badFlag.body.error).toBe("E2E_FIXTURE_PUBLISHED_INVALID");

    (service.setSlotProductPublished as jest.Mock).mockResolvedValue({ published: false });
    const ok = ctxWith({ params: { slot: "7" }, request: { headers: {}, body: { published: false } } });
    await controller.product(ok);
    expect(service.setSlotProductPublished).toHaveBeenCalledWith(expect.anything(), 7, false);
  });
});
