jest.mock("@strapi/utils", () => ({
  sanitize: { contentAPI: { output: jest.fn(async (rows) => rows) } },
}));

const mockFindPage = jest.fn();
const mockCountViews = jest.fn();
jest.mock("../../services/product-list-query", () => {
  const actual = jest.requireActual("../../services/product-list-query");
  return {
    ...actual,
    findProductListPage: (...args: unknown[]) => mockFindPage(...args),
    countProductListViews: (...args: unknown[]) => mockCountViews(...args),
  };
});

const mockEnabledSince = jest.fn();
jest.mock("../../../product/services/product-trash-retention", () => {
  const actual = jest.requireActual("../../../product/services/product-trash-retention");
  return { ...actual, readRetentionEnabledSince: (...args: unknown[]) => mockEnabledSince(...args) };
});

import controller from "../admin-product-list";
import routeConfig from "../../routes/admin-product-list";

const COUNTS = { all: 12, published: 7, drafts: 3, scheduled: 2, trash: 4 };

function createContext(body: unknown = {}) {
  return {
    request: { body },
    state: { auth: {}, user: { id: 1 } },
    body: null as any,
    badRequest: jest.fn(),
    set: jest.fn(),
  };
}

function installStrapi(rows: any[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  (global as any).strapi = {
    query: jest.fn(() => ({ findMany })),
    contentType: jest.fn(() => ({})),
    log: { info: jest.fn() },
  };
  return { findMany };
}

describe("admin products list", () => {
  const originalRetention = process.env.PRODUCT_TRASH_RETENTION_DAYS;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PRODUCT_TRASH_RETENTION_DAYS;
    mockCountViews.mockResolvedValue(COUNTS);
    mockEnabledSince.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalRetention === undefined) delete process.env.PRODUCT_TRASH_RETENTION_DAYS;
    else process.env.PRODUCT_TRASH_RETENTION_DAYS = originalRetention;
  });

  it("gates the list and the tab counts on product.read", () => {
    const paths = routeConfig.routes.map((route) => route.path);
    expect(paths).toEqual(["/admin/products-list/query", "/admin/products-list/counts"]);
    for (const route of routeConfig.routes) {
      expect(route.config.policies).toEqual([
        { name: "global::require-capability", config: { capability: "product.read" } },
      ]);
    }
  });

  it("hydrates the page of ids in order with the compact projection only", async () => {
    mockFindPage.mockResolvedValue({ ids: [9, 8], total: 3_004 });
    const { findMany } = installStrapi([
      {
        id: 8,
        Title: "Second",
        Status: "InActive",
        Description: "must-not-leak-richtext",
        CleaningTips: "must-not-leak",
        product_variations: [
          { id: 1, SKU: "SKU-1", Price: "100", product_stock: { id: 2, Count: 4, private: "must-not-leak" } },
        ],
        CoverImage: { id: 11, name: "image", url: "/safe.jpg", hash: "must-not-leak" },
      },
      { id: 9, Title: "First", Status: "Active", product_variations: [] },
    ]);
    const ctx = createContext({ view: "all", page: 1, pageSize: 25, search: "Synthetic" });

    await controller.query(ctx);

    const query = findMany.mock.calls[0][0];
    expect(query.where).toEqual({ id: { $in: [9, 8] } });
    expect(query.select).not.toContain("Description");
    expect(query.select).not.toContain("CleaningTips");
    expect(ctx.body.data.map((row: any) => row.id)).toEqual([9, 8]);
    expect(ctx.body.data[0].attributes.lifecycleState).toBe("published");
    expect(ctx.body.data[1].attributes.lifecycleState).toBe("draft");
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.body.meta).toEqual(
      expect.objectContaining({
        view: "all",
        sort: "last-edited",
        counts: COUNTS,
        recycleCount: 4,
        trashRetentionDays: 0,
        pagination: { page: 1, pageSize: 25, pageCount: 121, total: 3_004 },
      }),
    );
    expect(JSON.stringify(ctx.body)).not.toContain("must-not-leak");
  });

  it("shows Trash rows with who trashed them, what they were and when they will be purged", async () => {
    process.env.PRODUCT_TRASH_RETENTION_DAYS = "30";
    mockEnabledSince.mockResolvedValue(new Date("2026-09-01T00:00:00.000Z"));
    mockFindPage.mockResolvedValue({ ids: [3, 4], total: 2 });
    installStrapi([
      {
        id: 3,
        Title: "Trashed",
        Status: "InActive",
        removedAt: "2026-09-20T10:00:00.000Z",
        removedByLabel: "Sara Admin",
        preRemovalStatus: "Scheduled",
        preRemovalScheduledPublishAt: "2026-10-01T08:30:00.000Z",
      },
      // Legacy trash from before the lifecycle columns: its status was never demoted.
      { id: 4, Title: "Legacy", Status: "Active", removedAt: "2026-08-01T00:00:00.000Z" },
    ]);
    const ctx = createContext({ view: "trash" });

    await controller.query(ctx);

    const [trashed, legacy] = ctx.body.data.map((row: any) => row.attributes);
    expect(trashed).toEqual(
      expect.objectContaining({
        lifecycleState: "trashed",
        removedByLabel: "Sara Admin",
        preRemovalStatus: "Scheduled",
        preRemovalScheduledPublishAt: "2026-10-01T08:30:00.000Z",
        purgeAt: "2026-10-20T10:00:00.000Z",
      }),
    );
    // Retention clock starts at enablement for trash older than that.
    expect(legacy).toEqual(
      expect.objectContaining({ preRemovalStatus: "Active", purgeAt: "2026-10-01T00:00:00.000Z" }),
    );
    expect(ctx.body.meta.trashRetentionDays).toBe(30);
    expect(mockFindPage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ view: "trash", sort: "trashed-desc" }),
    );
  });

  it("rejects malformed criteria before touching the database", async () => {
    installStrapi();
    const ctx = createContext({ view: "all", sort: "Title; DROP TABLE products" });

    await controller.query(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Unsupported products-list sort");
    expect(mockFindPage).not.toHaveBeenCalled();
    expect(mockCountViews).not.toHaveBeenCalled();
  });

  it("counts every tab under the same filters, ignoring the tab itself", async () => {
    installStrapi();
    const ctx = createContext({ view: "trash", search: "shirt", stock: "out" });

    await controller.counts(ctx);

    expect(mockCountViews).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ view: "all", search: "shirt", stock: "out" }),
    );
    expect(ctx.body).toEqual({ data: { counts: COUNTS, trashRetentionDays: 0 } });
  });

  it("rejects a non-object counts body", async () => {
    installStrapi();
    const ctx = createContext([]);

    await controller.counts(ctx);

    expect(ctx.badRequest).toHaveBeenCalledWith("Request body must be an object");
    expect(mockCountViews).not.toHaveBeenCalled();
  });
});
