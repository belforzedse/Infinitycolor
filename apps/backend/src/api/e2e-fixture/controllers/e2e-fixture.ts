import { isValidFixtureSlot } from "../../../utils/e2eFixtures";
import {
  E2EFixtureError,
  cleanupShopper,
  provisionShopper,
  readSlotStock,
  setSlotProductPublished,
} from "../services/e2e-fixture";

const MAX_WALLET_TOMAN = 100_000_000;

function badRequest(ctx, error: string, message: string) {
  ctx.status = 400;
  ctx.body = { error, message };
}

function slotParam(ctx): number | null {
  const slot = Number(ctx.params?.slot);
  if (!/^\d+$/.test(String(ctx.params?.slot ?? "")) || !isValidFixtureSlot(slot)) {
    badRequest(ctx, "E2E_FIXTURE_SLOT_INVALID", "slot must be an integer from 0 to 63");
    return null;
  }
  return slot;
}

async function respond(ctx, work: () => Promise<unknown>) {
  try {
    ctx.body = { data: await work() };
  } catch (error) {
    if (error instanceof E2EFixtureError) {
      ctx.status = error.status;
      ctx.body = { error: error.code, message: error.message };
      return;
    }
    strapi.log.error("[e2e-fixture] request failed", {
      path: ctx.path,
      error: error instanceof Error ? error.message : String(error),
    });
    ctx.status = 500;
    ctx.body = {
      error: "E2E_FIXTURE_FAILED",
      message: error instanceof Error ? error.message : "fixture request failed",
    };
  }
}

export default {
  async provision(ctx) {
    const { slot, walletToman = 0 } = ctx.request.body ?? {};
    if (!isValidFixtureSlot(slot)) {
      return badRequest(ctx, "E2E_FIXTURE_SLOT_INVALID", "slot must be an integer from 0 to 63");
    }
    if (!Number.isInteger(walletToman) || walletToman < 0 || walletToman > MAX_WALLET_TOMAN) {
      return badRequest(ctx, "E2E_FIXTURE_WALLET_INVALID", "walletToman must be a non-negative integer");
    }
    await respond(ctx, () => provisionShopper(strapi, { slot, walletToman }));
  },

  async stock(ctx) {
    const slot = slotParam(ctx);
    if (slot === null) return;
    await respond(ctx, () => readSlotStock(strapi, slot));
  },

  async cleanup(ctx) {
    const slot = slotParam(ctx);
    if (slot === null) return;
    await respond(ctx, () => cleanupShopper(strapi, slot));
  },

  async product(ctx) {
    const slot = slotParam(ctx);
    if (slot === null) return;
    const { published } = ctx.request.body ?? {};
    if (typeof published !== "boolean") {
      return badRequest(ctx, "E2E_FIXTURE_PUBLISHED_INVALID", "published must be a boolean");
    }
    await respond(ctx, () => setSlotProductPublished(strapi, slot, published));
  },
};
