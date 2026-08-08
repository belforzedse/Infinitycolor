jest.mock("../../utils/revalidate", () => ({
  triggerFrontendRevalidation: jest.fn(async () => undefined),
}));

import { triggerFrontendRevalidation } from "../../utils/revalidate";
import { runPublishScheduledProductsTick } from "../publishScheduledProducts";

describe("runPublishScheduledProductsTick", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  function makeStrapi(overrides: Record<string, unknown> = {}) {
    const updates: Array<{ id: number; data: Record<string, unknown> }> = [];
    const knexUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = [];
    const products = new Map<number, Record<string, unknown>>();

    const strapi = {
      log: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
      entityService: {
        findMany: jest.fn(async () => Array.from(products.values())),
        findOne: jest.fn(async (_uid: string, id: number) => products.get(id) || null),
        update: jest.fn(async (_uid: string, id: number, { data }: { data: Record<string, unknown> }) => {
          updates.push({ id, data });
          const current = products.get(id) || {};
          products.set(id, { ...current, ...data });
          return products.get(id);
        }),
      },
      db: {
        connection: (table: string) => {
          expect(table).toBe("products");
          return {
            where(where: Record<string, unknown>) {
              return {
                async update(data: Record<string, unknown>) {
                  knexUpdates.push({ where, data });
                  const row = products.get(Number(where.id));
                  if (!row || row.Status !== "Scheduled" || where.status !== "Scheduled") {
                    return 0;
                  }
                  products.set(Number(where.id), {
                    ...row,
                    Status: "Active",
                    scheduledPublishAt: null,
                  });
                  return 1;
                },
              };
            },
          };
        },
      },
      ...overrides,
      __products: products,
      __updates: updates,
      __knexUpdates: knexUpdates,
    };
    return strapi as unknown as Parameters<typeof runPublishScheduledProductsTick>[0] & {
      __products: Map<number, Record<string, unknown>>;
      __updates: Array<{ id: number; data: Record<string, unknown> }>;
      __knexUpdates: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }>;
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("publishes a due scheduled product and revalidates", async () => {
    const strapi = makeStrapi();
    strapi.__products.set(10, {
      id: 10,
      Status: "Scheduled",
      Slug: "test-product",
      scheduledPublishAt: "2026-08-08T11:00:00.000Z",
      scheduledPublishRequireMedia: true,
      CoverImage: { id: 1 },
    });

    const result = await runPublishScheduledProductsTick(strapi, { now });
    expect(result).toEqual({ claimed: 1, published: 1, blocked: 0, skipped: 0 });
    expect(strapi.__knexUpdates).toHaveLength(1);
    expect(triggerFrontendRevalidation).toHaveBeenCalledWith(
      expect.objectContaining({ type: "product", path: "/pdp/test-product" }),
      "ScheduledProductPublish",
    );
  });

  it("keeps product unpublished before due time", async () => {
    const strapi = makeStrapi();
    strapi.__products.set(11, {
      id: 11,
      Status: "Scheduled",
      Slug: "later",
      scheduledPublishAt: "2026-08-08T13:00:00.000Z",
      scheduledPublishRequireMedia: false,
      CoverImage: null,
    });
    // findMany returns it, but re-check skips because scheduledAt > now
    const result = await runPublishScheduledProductsTick(strapi, { now });
    expect(result.published).toBe(0);
    expect(result.skipped).toBe(1);
    expect(strapi.__knexUpdates).toHaveLength(0);
  });

  it("blocks when media is required and cover is missing", async () => {
    const strapi = makeStrapi();
    strapi.__products.set(12, {
      id: 12,
      Status: "Scheduled",
      Slug: "no-cover",
      scheduledPublishAt: "2026-08-08T11:00:00.000Z",
      scheduledPublishRequireMedia: true,
      CoverImage: null,
    });
    const result = await runPublishScheduledProductsTick(strapi, { now });
    expect(result.blocked).toBe(1);
    expect(result.published).toBe(0);
    expect(strapi.__updates[0].data.scheduledPublishLastError).toMatch(/media-incomplete/);
  });

  it("second worker loses the atomic claim", async () => {
    const strapi = makeStrapi();
    strapi.__products.set(13, {
      id: 13,
      Status: "Scheduled",
      Slug: "race",
      scheduledPublishAt: "2026-08-08T11:00:00.000Z",
      scheduledPublishRequireMedia: false,
      CoverImage: null,
    });
    // Simulate another worker already published between findOne and claim.
    strapi.db.connection = () => ({
      where: () => ({
        update: async () => 0,
      }),
    });

    const result = await runPublishScheduledProductsTick(strapi, { now });
    expect(result.published).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("skips after cancellation (Status no longer Scheduled)", async () => {
    const strapi = makeStrapi();
    strapi.__products.set(14, {
      id: 14,
      Status: "InActive",
      Slug: "cancelled",
      scheduledPublishAt: "2026-08-08T11:00:00.000Z",
      scheduledPublishRequireMedia: false,
    });
    // findMany still returns stale list; findOne sees cancelled.
    (strapi.entityService.findMany as jest.Mock).mockResolvedValueOnce([
      { id: 14, Status: "Scheduled", scheduledPublishAt: "2026-08-08T11:00:00.000Z" },
    ]);
    const result = await runPublishScheduledProductsTick(strapi, { now });
    expect(result.skipped).toBe(1);
    expect(result.published).toBe(0);
  });
});
