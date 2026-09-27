import controller from "../admin-media-library";
import routeConfig from "../../routes/admin-media-library";

function createContext(body: unknown = {}) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn(),
    set: jest.fn(),
  };
}

function installStrapi({
  rows = [] as any[],
  total = 0,
  usageRows = [] as any[],
} = {}) {
  const raw = jest.fn(async (sql: string) => {
    if (sql.startsWith("SELECT COUNT(*)")) return { rows: [{ total: String(total) }] };
    if (sql.startsWith("WITH pairs")) return { rows: usageRows };
    return { rows };
  });
  (global as any).strapi = {
    db: { connection: { raw } },
    log: { info: jest.fn() },
  };
  return { raw };
}

const fileRow = {
  id: 5,
  name: "cover.webp",
  alternative_text: null,
  url: "/uploads/cover.webp",
  mime: "image/webp",
  ext: ".webp",
  width: 800,
  height: 1000,
  size: "20.5",
  formats: null,
  created_at: "2026-09-20T10:00:00.000Z",
  video_status: null,
  video_poster_url: null,
};

describe("admin media library", () => {
  it("uses the product-media capability policy", () => {
    expect(routeConfig.routes[0]).toMatchObject({
      method: "POST",
      path: "/admin/media-library/query",
      handler: "admin-media-library.query",
    });
    expect(routeConfig.routes[0].config.policies[0]).toEqual({
      name: "global::require-capability",
      config: { capability: "product.media.manage" },
    });
  });

  it.each([
    ["a non-object body", []],
    ["an unknown type", { type: "file" }],
    ["an unknown usage", { usage: "orphans" }],
    ["an over-long search", { search: "x".repeat(81) }],
  ])("rejects %s before querying", async (_label, body) => {
    const { raw } = installStrapi();
    const ctx = createContext(body);

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalled();
    expect(raw).not.toHaveBeenCalled();
  });

  it("returns a page with usage and the full total", async () => {
    const { raw } = installStrapi({
      rows: [fileRow],
      total: 312,
      usageRows: [
        {
          file_id: 5,
          product_id: 9,
          title: "مانتو",
          removed: false,
          as_cover: true,
          active_count: "1",
          removed_count: "0",
          active_cover: true,
        },
      ],
    });
    const ctx = createContext({ page: 2, pageSize: 24, search: "مانتو" });

    await controller.query(ctx);

    expect(raw).toHaveBeenCalledTimes(3);
    const pageCall = raw.mock.calls.find(([sql]) => sql.startsWith("SELECT f.id"));
    expect(pageCall?.[1]).toEqual(expect.arrayContaining(["%مانتو%"]));
    expect(pageCall?.[1].slice(-2)).toEqual([24, 24]);
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.meta.pagination).toEqual({ page: 2, pageSize: 24, pageCount: 13, total: 312 });
    expect(ctx.body.data).toHaveLength(1);
    expect(ctx.body.data[0]).toMatchObject({
      id: 5,
      size: 20.5,
      usage: {
        productCount: 1,
        usedAsCover: true,
        products: [{ id: 9, title: "مانتو", removed: false, asCover: true }],
      },
    });
  });

  it("clamps the page size and skips the usage query for an empty page", async () => {
    const { raw } = installStrapi({ rows: [], total: 0 });
    const ctx = createContext({ pageSize: 500, type: "video", usage: "unattached" });

    await controller.query(ctx);

    expect(raw).toHaveBeenCalledTimes(2);
    const pageCall = raw.mock.calls.find(([sql]) => sql.startsWith("SELECT f.id"));
    expect(pageCall?.[1][0]).toBe("video/%");
    expect(pageCall?.[1].slice(-2)).toEqual([60, 0]);
    expect(ctx.body).toEqual({
      data: [],
      meta: { pagination: { page: 1, pageSize: 60, pageCount: 0, total: 0 } },
    });
  });
});
