import type { Strapi } from "@strapi/strapi";
import type { Context } from "koa";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import createController from "../../../api/product/controllers/product-title-suggestions";
import { makeFactories, type Factories } from "../factories";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

let strapi: any;
let f: Factories;
let temporaryRoot: string;
let controllers: ReturnType<typeof createController>[];
const previousRole = process.env.PROCESS_ROLE;

beforeAll(async () => {
  process.env.PROCESS_ROLE = "web";
  strapi = await setupStrapi();
});

afterAll(async () => {
  await teardownStrapi();
  if (previousRole === undefined) delete process.env.PROCESS_ROLE;
  else process.env.PROCESS_ROLE = previousRole;
});

beforeEach(async () => {
  f = makeFactories(strapi);
  temporaryRoot = await mkdtemp(path.join(tmpdir(), "infinity-title-suggestions-"));
  // Separate service consumers have distinct Strapi identities, as replicas do.
  // Both use the real query engine/DB; no lifecycle or refresh signal is shared.
  controllers = [0, 1].map(() => createController({
    strapi: {
      db: strapi.db,
      dirs: { app: { root: temporaryRoot } },
    } as Strapi,
  }));
});

afterEach(async () => {
  await f.cleanup();
  await rm(temporaryRoot, { recursive: true, force: true });
});

async function keywords(controller = controllers[0]): Promise<string[]> {
  const ctx = { set: jest.fn() } as unknown as Context;
  await controller.index(ctx);
  expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  return (ctx.body as { data: { keywords: string[] } }).data.keywords;
}

describe("product title suggestions (real Postgres)", () => {
  it("serves a cold web request without background jobs or a local dictionary, including drafts and scheduled products", async () => {
    expect(process.env.DISABLE_BACKGROUND_JOBS).toBe("true");
    expect(process.env.PROCESS_ROLE).toBe("web");
    await f.createProduct({ title: "مخمل", status: "Active" });
    await f.createProduct({ title: "حریر", status: "InActive" });
    await f.createProduct({ title: "ابریشم", status: "Scheduled" });

    await expect(access(path.join(temporaryRoot, ".tmp"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(keywords()).resolves.toEqual(expect.arrayContaining(["مخمل", "حریر", "ابریشم"]));
    await expect(access(path.join(temporaryRoot, ".tmp"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads raw rename, trash, restore and purge changes on the next request from either consumer", async () => {
    const product = await f.createProduct({ title: "ژاکارد", status: "InActive" });
    const productRow = () => strapi.db.connection("products").where({ id: product.id });

    for (const controller of controllers) {
      await expect(keywords(controller)).resolves.toContain("ژاکارد");
    }

    // Raw SQL deliberately bypasses the product lifecycle, matching the catalog
    // trash/restore/purge commands and changes made on another application node.
    await productRow().update({ title: "ساتن" });
    for (const controller of controllers) {
      const current = await keywords(controller);
      expect(current).toContain("ساتن");
      expect(current).not.toContain("ژاکارد");
    }

    await productRow().update({ removed_at: new Date() });
    for (const controller of controllers) {
      await expect(keywords(controller)).resolves.not.toContain("ساتن");
    }

    await productRow().update({ removed_at: null });
    for (const controller of controllers) {
      await expect(keywords(controller)).resolves.toContain("ساتن");
    }

    await productRow().update({ purged_at: new Date() });
    for (const controller of controllers) {
      await expect(keywords(controller)).resolves.not.toContain("ساتن");
    }
  });
});
