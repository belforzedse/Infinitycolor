import {
  getSnapshot,
  MigrationInputError,
  restoreMediaTimestamps,
  upsertOrder,
  upsertUser,
  upsertWallet,
} from "../services/wordpress-migration";
import {
  finalizeCategoryEditorial,
  prepareCategoryEditorial,
} from "../services/category-editorial-migration";

async function respond(ctx: any, action: (body: unknown) => Promise<unknown>) {
  try {
    ctx.body = { data: await action(ctx.request.body ?? {}) };
  } catch (error) {
    if (error instanceof MigrationInputError) {
      ctx.status = error.status;
      ctx.body = { error: error.code };
      return;
    }
    strapi.log.error("WordPress migration write failed", {
      operation: ctx.request.path,
      reasonCode: error instanceof Error ? error.name : "UNKNOWN",
    });
    ctx.status = 500;
    ctx.body = { error: "MIGRATION_WRITE_FAILED" };
  }
}

export default {
  async snapshot(ctx: any) {
    await respond(ctx, () => getSnapshot(strapi, ctx.request.query ?? {}));
  },
  async upsertUser(ctx: any) {
    await respond(ctx, (body) => upsertUser(strapi, body));
  },
  async upsertWallet(ctx: any) {
    await respond(ctx, (body) => upsertWallet(strapi, body));
  },
  async upsertOrder(ctx: any) {
    await respond(ctx, (body) => upsertOrder(strapi, body));
  },
  async restoreMediaTimestamps(ctx: any) {
    await respond(ctx, (body) => restoreMediaTimestamps(strapi, body));
  },
  async prepareCategoryEditorial(ctx: any) {
    await respond(ctx, (body) => prepareCategoryEditorial(strapi, body));
  },
  async finalizeCategoryEditorial(ctx: any) {
    await respond(ctx, (body) => finalizeCategoryEditorial(strapi, body));
  },
};
