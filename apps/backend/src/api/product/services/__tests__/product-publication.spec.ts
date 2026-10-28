jest.mock("../../../../utils/responseCache", () => ({
  delByPatternStrict: jest.fn(),
}));

jest.mock("../../../../utils/revalidate", () => ({
  triggerFrontendRevalidation: jest.fn(),
}));

jest.mock("../../../../utils/homepageRevalidation", () => ({
  scheduleHomeProductsRevalidation: jest.fn(),
}));

jest.mock("../../../../audit/writer", () => ({
  resolveCurrentAuditContext: jest.fn(() => ({
    actor: { type: "human", id: 7, label: "Admin", role: "Superadmin" },
    initiator: { type: "human", id: 7, label: "Admin", role: "Superadmin" },
    origin: "admin_ui",
    requestId: "publication-unit-request",
    interactionId: null,
    correlationId: "publication-unit-correlation",
  })),
  writeAuditEvent: jest.fn().mockResolvedValue({
    id: 1,
    eventId: "00000000-0000-4000-a000-000000000001",
    deduplicated: false,
  }),
}));

import { delByPatternStrict } from "../../../../utils/responseCache";
import { triggerFrontendRevalidation } from "../../../../utils/revalidate";
import { writeAuditEvent } from "../../../../audit/writer";
import { scheduleHomeProductsRevalidation } from "../../../../utils/homepageRevalidation";
import {
  executePublicationCommand,
  PublicationCommandError,
  publishScheduledProduct,
  recordScheduledPublicationTransientFailure,
  runPublicationEffects,
  runPublicationEffectsBatch,
} from "../product-publication";

const mockedPurge = delByPatternStrict as jest.MockedFunction<typeof delByPatternStrict>;
const mockedRevalidate = triggerFrontendRevalidation as jest.MockedFunction<
  typeof triggerFrontendRevalidation
>;
const mockedWriteAudit = writeAuditEvent as jest.MockedFunction<typeof writeAuditEvent>;
const mockedHomeRevalidate = scheduleHomeProductsRevalidation as jest.MockedFunction<
  typeof scheduleHomeProductsRevalidation
>;

type Row = Record<string, any> & { id: number };

function productRow(overrides: Partial<Row> = {}): Row {
  return {
    id: 1,
    title: "Test product",
    slug: "test-product",
    status: "InActive",
    removed_at: null,
    external_source: "woocommerce",
    external_id: "101",
    scheduled_publish_at: null,
    scheduled_publish_timezone: null,
    scheduled_publish_revision: 0,
    scheduled_publish_require_media: false,
    scheduled_publish_last_attempt_at: null,
    scheduled_publish_last_error: null,
    scheduled_publish_failure_kind: null,
    scheduled_publish_attempt_count: 0,
    scheduled_publish_next_retry_at: null,
    publication_revision: 0,
    publication_effects_completed_revision: 0,
    publication_effects_last_error: null,
    ...overrides,
  };
}

type VariationRow = { id: number; is_published: boolean | null };

/**
 * Fake knex over a table-keyed row store: `products` plus the variation tables
 * the publish cascade touches.
 */
function makeStrapi(
  initialRows: Row[],
  opts: { cover?: unknown; variations?: VariationRow[]; variationProductId?: number } = {},
) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }] as [number, any]));
  const linkedProductId = opts.variationProductId ?? 1;
  const variations = new Map(
    (opts.variations || []).map((row) => [row.id, { ...row }] as [number, any]),
  );
  const links = new Map(
    (opts.variations || []).map(
      (row, index) =>
        [
          index + 1,
          { id: index + 1, product_variation_id: row.id, product_id: linkedProductId },
        ] as [number, any],
    ),
  );
  const tables: Record<string, Map<number, any>> = {
    products: rows,
    product_variations: variations,
    product_variations_product_links: links,
  };

  class Query {
    filters: Array<(row: any) => boolean> = [];
    columns: string[] | null = null;

    constructor(private store: Map<number, any>) {}

    where(arg1: Record<string, unknown> | string, arg2?: unknown) {
      if (typeof arg1 === "string") {
        this.filters.push((row) => row[arg1] === arg2);
      } else {
        this.filters.push((row) =>
          Object.entries(arg1).every(([key, value]) => row[key] === value),
        );
      }
      return this;
    }

    andWhere(arg1: Record<string, unknown> | string, arg2?: unknown) {
      return this.where(arg1 as any, arg2);
    }

    whereIn(column: string, values: unknown[]) {
      const allowed = new Set(values);
      this.filters.push((row) => allowed.has(row[column]));
      return this;
    }

    whereNull(column: string) {
      this.filters.push((row) => row[column] === null || row[column] === undefined);
      return this;
    }

    whereNot(column: string, value: unknown) {
      this.filters.push((row) => row[column] !== value);
      return this;
    }

    select(...columns: string[]) {
      this.columns = columns.flat();
      return this;
    }

    forUpdate() {
      return this;
    }

    matching() {
      return Array.from(this.store.values()).filter((row) =>
        this.filters.every((filter) => filter(row)),
      );
    }

    /** Awaiting the builder resolves the projected rows, the way knex does. */
    then(resolve: (value: any) => unknown, reject?: (reason: unknown) => unknown) {
      const projected = this.matching().map((row) =>
        this.columns
          ? Object.fromEntries(this.columns.map((column) => [column, row[column]]))
          : { ...row },
      );
      return Promise.resolve(projected).then(resolve, reject);
    }

    async first() {
      const row = this.matching()[0];
      return row ? { ...row } : undefined;
    }

    async update(data: Record<string, unknown>) {
      const matches = this.matching();
      matches.forEach((row) => Object.assign(this.store.get(row.id)!, data));
      return matches.length;
    }
  }

  const connection = jest.fn((table: string) => {
    const store = tables[table];
    if (!store) throw new Error(`Unexpected table in publication query: ${table}`);
    return new Query(store);
  });
  // The active-slug guard takes the same advisory lock as the prod trigger.
  const trx = Object.assign((table: string) => connection(table), {
    raw: jest.fn().mockResolvedValue({ rows: [] }),
  });
  const entityCreate = jest.fn().mockResolvedValue({ id: 99 });
  const cover = Object.prototype.hasOwnProperty.call(opts, "cover") ? opts.cover : { id: 7 };
  const strapi = {
    db: {
      connection,
      transaction: jest.fn(async (callback: any) => callback({ trx })),
    },
    entityService: {
      create: entityCreate,
      findOne: jest.fn().mockResolvedValue({ id: 1, CoverImage: cover }),
    },
    log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    __row(id = 1) {
      return rows.get(id)!;
    },
    __variation(id: number) {
      return variations.get(id)!;
    },
    __entityCreate: entityCreate,
  };
  return strapi as any;
}

const now = new Date("2026-08-08T10:00:00.000Z");
const firstAt = "2026-08-08T12:00:00.000Z";
const laterAt = "2026-08-08T13:00:00.000Z";

describe("canonical product publication service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedPurge.mockResolvedValue(4);
    mockedRevalidate.mockResolvedValue({ attempted: 1, successful: 1, failed: 0 });
  });

  it("schedules, reschedules, and treats an identical request as a no-op", async () => {
    const strapi = makeStrapi([productRow()]);

    const scheduled = await executePublicationCommand(
      strapi,
      1,
      { action: "schedule", publishAt: firstAt, timezone: "Asia/Tehran" },
      { origin: "admin", now },
    );
    expect(scheduled).toEqual(expect.objectContaining({
      status: "Scheduled",
      scheduledPublishAt: firstAt,
      scheduleRevision: 1,
      changed: true,
    }));
    expect(mockedWriteAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        eventKey: "products.publication_scheduled",
        actor: expect.objectContaining({ type: "human", id: 7 }),
        initiator: expect.objectContaining({ type: "human", id: 7 }),
        origin: "admin_ui",
        result: "success",
      }),
      expect.objectContaining({ trx: expect.any(Function) }),
    );

    const identical = await executePublicationCommand(
      strapi,
      1,
      { action: "schedule", publishAt: firstAt, timezone: "Asia/Tehran" },
      { origin: "admin", now },
    );
    expect(identical).toEqual(expect.objectContaining({ scheduleRevision: 1, changed: false }));
    expect(identical.previousScheduleRevision).toBeUndefined();

    const rescheduled = await executePublicationCommand(
      strapi,
      1,
      { action: "schedule", publishAt: laterAt, timezone: "Asia/Tehran" },
      { origin: "admin", now },
    );
    expect(rescheduled).toEqual(expect.objectContaining({
      scheduledPublishAt: laterAt,
      scheduleRevision: 2,
      previousScheduleRevision: 1,
      changed: true,
    }));
    expect(strapi.__entityCreate).toHaveBeenCalledTimes(2);
  });

  it("cancels a schedule and obsoletes its revision", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: firstAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 4,
    })]);

    const result = await executePublicationCommand(
      strapi,
      1,
      { action: "cancel" },
      { origin: "admin", now },
    );

    expect(result).toEqual(expect.objectContaining({
      status: "InActive",
      scheduleRevision: 5,
      scheduledPublishAt: null,
      changed: true,
    }));
  });

  it("publishes immediately once and makes repeated publication idempotent", async () => {
    const strapi = makeStrapi([productRow()]);

    const first = await executePublicationCommand(
      strapi,
      1,
      { action: "publish-now" },
      { origin: "admin", now },
    );
    const second = await executePublicationCommand(
      strapi,
      1,
      { action: "publish-now" },
      { origin: "admin", now },
    );

    expect(first).toEqual(expect.objectContaining({
      status: "Active",
      publicationRevision: 1,
      changed: true,
      needsPublicationEffects: true,
    }));
    expect(second).toEqual(expect.objectContaining({
      status: "Active",
      publicationRevision: 1,
      changed: false,
    }));
    expect(strapi.__entityCreate).toHaveBeenCalledTimes(1);
  });

  it("stamps published_at once on first publish-now and keeps it stable across an unpublish/republish cycle", async () => {
    const strapi = makeStrapi([productRow({ published_at: null })]);

    await executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now });
    const firstPublishedAt = strapi.__row(1).published_at;
    expect(firstPublishedAt).toEqual(now);

    const later = new Date(now.getTime() + 60_000);
    await executePublicationCommand(strapi, 1, { action: "unpublish" }, { origin: "admin", now: later });
    const evenLater = new Date(later.getTime() + 60_000);
    await executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now: evenLater });

    expect(strapi.__row(1).published_at).toEqual(firstPublishedAt);
  });

  it("publishes the product's unpublished variations along with it", async () => {
    const strapi = makeStrapi([productRow()], {
      variations: [
        { id: 10, is_published: false },
        { id: 11, is_published: true },
        { id: 12, is_published: null },
      ],
    });

    const result = await executePublicationCommand(
      strapi,
      1,
      { action: "publish-now" },
      { origin: "admin", now },
    );

    expect(result).toEqual(expect.objectContaining({
      status: "Active",
      changed: true,
      publishedVariationCount: 2,
    }));
    expect(strapi.__variation(10).is_published).toBe(true);
    expect(strapi.__variation(11).is_published).toBe(true);
    expect(strapi.__variation(12).is_published).toBe(true);
    expect(mockedHomeRevalidate).toHaveBeenCalledWith(
      "product-publication-cascade",
      expect.objectContaining({ productId: 1, publishedVariationCount: 2 }),
    );
  });

  it("leaves other products' variations untouched and re-publishes nothing when already Active", async () => {
    const strapi = makeStrapi([productRow(), productRow({ id: 2, slug: "other" })], {
      variations: [{ id: 10, is_published: false }],
      variationProductId: 2,
    });

    const result = await executePublicationCommand(
      strapi,
      1,
      { action: "publish-now" },
      { origin: "admin", now },
    );

    expect(result.publishedVariationCount).toBe(0);
    expect(strapi.__variation(10).is_published).toBe(false);
    expect(mockedHomeRevalidate).not.toHaveBeenCalled();
  });

  it("does not cascade for importer-driven publishes, which map variation status themselves", async () => {
    const strapi = makeStrapi([productRow()], {
      variations: [{ id: 10, is_published: false }],
    });

    const result = await executePublicationCommand(
      strapi,
      1,
      { action: "publish-now", expectedExternalSource: "woocommerce", expectedExternalId: "101" },
      { origin: "importer", now },
    );

    expect(result.status).toBe("Active");
    expect(result.publishedVariationCount).toBe(0);
    expect(strapi.__variation(10).is_published).toBe(false);
  });

  it("leaves variation flags alone when unpublishing", async () => {
    const strapi = makeStrapi([productRow({ status: "Active", publication_revision: 1 })], {
      variations: [{ id: 10, is_published: true }],
    });

    await executePublicationCommand(strapi, 1, { action: "unpublish" }, { origin: "admin", now });

    expect(strapi.__row(1).status).toBe("InActive");
    expect(strapi.__variation(10).is_published).toBe(true);
  });

  it("rejects future scheduling for an already Active product", async () => {
    const strapi = makeStrapi([productRow({ status: "Active" })]);

    await expect(executePublicationCommand(
      strapi,
      1,
      { action: "schedule", publishAt: firstAt, timezone: "Asia/Tehran" },
      { origin: "importer", now },
    )).rejects.toMatchObject<Partial<PublicationCommandError>>({
      code: "SCHEDULED_UPDATE_UNSUPPORTED",
      status: 409,
    });
  });

  it("requires a matching Woo external identity for importer commands", async () => {
    const strapi = makeStrapi([productRow()]);

    await expect(executePublicationCommand(
      strapi,
      1,
      {
        action: "publish-now",
        expectedExternalSource: "woocommerce",
        expectedExternalId: "999",
      },
      { origin: "importer", now },
    )).rejects.toMatchObject({ code: "EXTERNAL_PRODUCT_MISMATCH", status: 409 });
  });

  it("re-reads revision and timestamp so stale deliveries are no-ops", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: laterAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 2,
    })]);

    const attempt = await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T14:00:00.000Z"),
    });

    expect(attempt.outcome).toBe("stale");
    expect(strapi.__row().status).toBe("Scheduled");
  });

  it("reports early delivery without changing persisted state", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: laterAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 2,
    })]);

    const attempt = await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 2,
      expectedPublishAt: laterAt,
      now,
    });

    expect(attempt).toEqual(expect.objectContaining({ outcome: "early", dueAt: laterAt }));
    expect(strapi.__row().status).toBe("Scheduled");
  });

  it("persists a permanent media failure until an explicit retry", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: firstAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 2,
      scheduled_publish_require_media: true,
    })], { cover: null });

    const attempt = await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 2,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T12:01:00.000Z"),
    });

    expect(attempt).toEqual(expect.objectContaining({
      outcome: "permanent-failure",
      code: "PRODUCT_COVER_MEDIA_REQUIRED",
    }));
    expect(strapi.__row()).toEqual(expect.objectContaining({
      status: "Scheduled",
      scheduled_publish_failure_kind: "Permanent",
      scheduled_publish_attempt_count: 1,
    }));

    const retried = await executePublicationCommand(
      strapi,
      1,
      { action: "retry" },
      { origin: "admin", now: new Date("2026-08-08T12:02:00.000Z") },
    );
    expect(retried.scheduleRevision).toBe(3);
    expect(strapi.__row().scheduled_publish_failure_kind).toBeNull();
  });

  it("publishes exactly once across repeated deliveries", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: firstAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 1,
    })]);
    const delivery = {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T12:01:00.000Z"),
    };

    const first = await publishScheduledProduct(strapi, delivery);
    const repeated = await publishScheduledProduct(strapi, delivery);

    expect(first.outcome).toBe("published");
    expect(repeated.outcome).toBe("already-published");
    expect(mockedWriteAudit).toHaveBeenCalledWith(
      strapi,
      expect.objectContaining({
        eventKey: "products.publication_executed",
        actor: expect.objectContaining({ type: "scheduled_job" }),
        result: "success",
      }),
      expect.objectContaining({ trx: expect.any(Function) }),
    );
    expect(strapi.__row().publication_revision).toBe(1);
    expect(strapi.__entityCreate).toHaveBeenCalledTimes(1);
  });

  it("cascades to variations when the scheduler publishes, same as an immediate publish", async () => {
    const strapi = makeStrapi(
      [productRow({
        status: "Scheduled",
        scheduled_publish_at: firstAt,
        scheduled_publish_timezone: "Asia/Tehran",
        scheduled_publish_revision: 1,
      })],
      { variations: [{ id: 10, is_published: false }, { id: 11, is_published: true }] },
    );

    const attempt = await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T12:01:00.000Z"),
    });

    expect(attempt.outcome).toBe("published");
    expect(attempt.result.publishedVariationCount).toBe(1);
    expect(strapi.__variation(10).is_published).toBe(true);
    expect(mockedHomeRevalidate).toHaveBeenCalledWith(
      "product-publication-cascade",
      expect.objectContaining({ productId: 1, publishedVariationCount: 1 }),
    );
  });

  it("stamps published_at and last_edited_by_admin_at when the scheduler publishes an admin-created schedule", async () => {
    const strapi = makeStrapi([
      productRow({
        status: "Scheduled",
        scheduled_publish_at: firstAt,
        scheduled_publish_timezone: "Asia/Tehran",
        scheduled_publish_revision: 1,
        last_edited_by_admin_at: "2026-08-01T00:00:00.000Z",
        published_at: null,
      }),
    ]);
    const firedAt = new Date("2026-08-08T12:01:00.000Z");

    await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: firedAt,
    });

    expect(strapi.__row(1).published_at).toEqual(firedAt);
    expect(strapi.__row(1).last_edited_by_admin_at).toEqual(firedAt);
  });

  it("does not treat an importer-scheduled fire as an admin edit", async () => {
    const strapi = makeStrapi(
      [productRow({
        status: "Scheduled",
        scheduled_publish_at: firstAt,
        scheduled_publish_timezone: "Asia/Tehran",
        scheduled_publish_revision: 1,
        scheduled_publish_audit_context: { schemaVersion: 1, origin: "import" } as any,
        last_edited_by_admin_at: "2026-08-01T00:00:00.000Z",
        published_at: null,
      })],
      { variations: [{ id: 10, is_published: false }] },
    );
    const firedAt = new Date("2026-08-08T12:01:00.000Z");

    await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: firedAt,
    });

    expect(strapi.__row(1).published_at).toEqual(firedAt);
    expect(strapi.__row(1).last_edited_by_admin_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("skips the cascade when the scheduler fires an importer-created schedule", async () => {
    const strapi = makeStrapi(
      [productRow({
        status: "Scheduled",
        scheduled_publish_at: firstAt,
        scheduled_publish_timezone: "Asia/Tehran",
        scheduled_publish_revision: 1,
        scheduled_publish_audit_context: { schemaVersion: 1, origin: "import" } as any,
      })],
      { variations: [{ id: 10, is_published: false }] },
    );

    const attempt = await publishScheduledProduct(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      now: new Date("2026-08-08T12:01:00.000Z"),
    });

    expect(attempt.outcome).toBe("published");
    expect(attempt.result.publishedVariationCount).toBe(0);
    expect(strapi.__variation(10).is_published).toBe(false);
  });

  it("persists transient retry metadata only while the schedule revision is current", async () => {
    const strapi = makeStrapi([productRow({
      status: "Scheduled",
      scheduled_publish_at: firstAt,
      scheduled_publish_timezone: "Asia/Tehran",
      scheduled_publish_revision: 2,
      scheduled_publish_attempt_count: 1,
    })]);

    await expect(recordScheduledPublicationTransientFailure(strapi, {
      productId: 1,
      scheduleRevision: 2,
      expectedPublishAt: firstAt,
      error: new Error("redis timeout"),
      now,
      retryDelayMs: 60_000,
    })).resolves.toBe(true);
    expect(strapi.__row()).toEqual(expect.objectContaining({
      scheduled_publish_failure_kind: "Transient",
      scheduled_publish_attempt_count: 2,
      scheduled_publish_last_error: "redis timeout",
      scheduled_publish_next_retry_at: new Date("2026-08-08T10:01:00.000Z"),
    }));

    await expect(recordScheduledPublicationTransientFailure(strapi, {
      productId: 1,
      scheduleRevision: 1,
      expectedPublishAt: firstAt,
      error: new Error("stale worker"),
      now,
      retryDelayMs: 60_000,
    })).resolves.toBe(false);
    expect(strapi.__row().scheduled_publish_last_error).toBe("redis timeout");
  });

  it("keeps effects pending after failure and completes the same revision on retry", async () => {
    const strapi = makeStrapi([productRow({
      status: "Active",
      publication_revision: 3,
      publication_effects_completed_revision: 2,
    })]);
    mockedPurge.mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(runPublicationEffects(strapi, 1, 3)).rejects.toThrow("redis unavailable");
    expect(strapi.__row()).toEqual(expect.objectContaining({
      publication_effects_completed_revision: 2,
      publication_effects_last_error: "redis unavailable",
    }));

    mockedPurge.mockResolvedValueOnce(9);
    await expect(runPublicationEffects(strapi, 1, 3)).resolves.toEqual({
      completed: true,
      revision: 3,
    });
    expect(strapi.__row()).toEqual(expect.objectContaining({
      publication_effects_completed_revision: 3,
      publication_effects_last_error: null,
    }));
    expect(mockedRevalidate).toHaveBeenCalledWith(
      { type: "product", path: "test-product" },
      "ProductPublication",
    );
  });

  describe("lifecycle guards", () => {
    it.each([
      ["publish-now", {}],
      ["schedule", { publishAt: firstAt, timezone: "Asia/Tehran" }],
      ["unpublish", {}],
      ["retry", {}],
      ["cancel", {}],
    ])("refuses %s on a product in Trash without touching it", async (action, extra) => {
      const strapi = makeStrapi([
        productRow({ status: "InActive", removed_at: new Date("2026-08-01T00:00:00.000Z") }),
      ]);

      await expect(
        executePublicationCommand(strapi, 1, { action: action as any, ...extra }, { origin: "admin", now }),
      ).rejects.toMatchObject({ code: "PRODUCT_REMOVED", status: 422 });
      expect(strapi.__row()).toEqual(expect.objectContaining({ status: "InActive", publication_revision: 0 }));
      expect(mockedWriteAudit).not.toHaveBeenCalled();
    });

    it("refuses every publication command on a permanently deleted tombstone", async () => {
      const strapi = makeStrapi([
        productRow({
          removed_at: new Date("2026-08-01T00:00:00.000Z"),
          purged_at: new Date("2026-08-02T00:00:00.000Z"),
        }),
      ]);

      await expect(
        executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now }),
      ).rejects.toMatchObject({ code: "PRODUCT_PURGED", status: 409 });
    });

    it("refuses to publish into a slug another live product already owns", async () => {
      const strapi = makeStrapi([
        productRow({ id: 1, slug: "shared-slug", status: "InActive" }),
        productRow({ id: 2, slug: "shared-slug", status: "Active" }),
      ]);

      await expect(
        executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now }),
      ).rejects.toMatchObject({ code: "PRODUCT_SLUG_CONFLICT", status: 409 });
      expect(strapi.__row(1).status).toBe("InActive");
    });

    it("lets the slug be reused once the live holder is in Trash", async () => {
      const strapi = makeStrapi([
        productRow({ id: 1, slug: "shared-slug", status: "InActive" }),
        productRow({
          id: 2,
          slug: "shared-slug",
          status: "InActive",
          removed_at: new Date("2026-08-01T00:00:00.000Z"),
        }),
      ]);

      await expect(
        executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now }),
      ).resolves.toEqual(expect.objectContaining({ status: "Active", changed: true }));
    });

    it("maps a slug violation raised by the database trigger to the same controlled error", async () => {
      const strapi = makeStrapi([productRow()]);
      const violation = Object.assign(new Error("PRODUCT_ACTIVE_SLUG_DUPLICATE"), { code: "23505" });
      strapi.db.transaction.mockRejectedValueOnce(violation);

      await expect(
        executePublicationCommand(strapi, 1, { action: "publish-now" }, { origin: "admin", now }),
      ).rejects.toMatchObject({ code: "PRODUCT_SLUG_CONFLICT", status: 409 });
    });

    it("parks a due schedule whose slug was taken as a permanent failure instead of retrying", async () => {
      const strapi = makeStrapi([
        productRow({
          id: 1,
          slug: "shared-slug",
          status: "Scheduled",
          scheduled_publish_at: new Date(firstAt),
          scheduled_publish_revision: 1,
        }),
        productRow({ id: 2, slug: "shared-slug", status: "Active" }),
      ]);

      const attempt = await publishScheduledProduct(strapi, {
        productId: 1,
        scheduleRevision: 1,
        expectedPublishAt: firstAt,
        now: new Date("2026-08-08T12:00:01.000Z"),
      });

      expect(attempt).toEqual(expect.objectContaining({ outcome: "permanent-failure", code: "PRODUCT_SLUG_CONFLICT" }));
      expect(strapi.__row(1)).toEqual(expect.objectContaining({
        status: "Scheduled",
        scheduled_publish_failure_kind: "Permanent",
      }));
    });
  });

  describe("publication effects", () => {
    it("also clears the rest-cache product lists and schedules the homepage refresh", async () => {
      const strapi = makeStrapi([productRow({
        status: "Active",
        publication_revision: 2,
        publication_effects_completed_revision: 1,
      })]);
      const clearByUid = jest.fn().mockResolvedValue(undefined);
      strapi.plugin = jest.fn(() => ({ service: () => ({ clearByUid }) }));

      await expect(runPublicationEffects(strapi, 1, 2)).resolves.toEqual({ completed: true, revision: 2 });

      expect(clearByUid).toHaveBeenCalledWith("api::product.product", {}, true);
      expect(mockedHomeRevalidate).toHaveBeenCalled();
    });

    it("purges shared caches once for a batch and revalidates each product's own page", async () => {
      const strapi = makeStrapi([
        productRow({ id: 1, slug: "one", publication_revision: 2, publication_effects_completed_revision: 1 }),
        productRow({ id: 2, slug: "two", publication_revision: 5, publication_effects_completed_revision: 4 }),
        productRow({ id: 3, slug: "done", publication_revision: 1, publication_effects_completed_revision: 1 }),
      ]);
      mockedRevalidate
        .mockResolvedValueOnce({ attempted: 1, successful: 1, failed: 0 })
        .mockResolvedValueOnce({ attempted: 1, successful: 0, failed: 1 });

      const summary = await runPublicationEffectsBatch(strapi, [1, 2, 3, 2]);

      expect(mockedPurge).toHaveBeenCalledTimes(1);
      expect(mockedRevalidate).toHaveBeenCalledTimes(2);
      expect(summary.completed).toHaveLength(1);
      expect(summary.failed).toHaveLength(1);
      const failedId = summary.failed[0];
      const completedId = summary.completed[0];
      expect(strapi.__row(completedId).publication_effects_last_error).toBeNull();
      expect(strapi.__row(failedId)).toEqual(expect.objectContaining({
        publication_effects_last_error: "STOREFRONT_REVALIDATION_FAILED",
      }));
      // Nothing pending for product 3, so it is left alone.
      expect(strapi.__row(3).publication_effects_completed_revision).toBe(1);
    });
  });
});

// Domain-query doubles do not model the lease tables. The coordination layer
// is exercised against PostgreSQL in product-edit-coordination.int.spec.ts.
jest.mock("../../../../utils/catalogEdit", () => {
  let active = false;
  let effects: Array<() => Promise<unknown>> = [];
  const run = async (...args: any[]) => {
    active = true;
    try { return await args[args.length - 1](); }
    finally {
      active = false;
      const pending = effects; effects = [];
      for (const effect of pending) await effect();
    }
  };
  return {
    catalogMutationContext: () => active ? {} : undefined,
    coordinateCatalogCommand: run,
    runCatalogSystemMutation: run,
    afterCatalogCommit: async (_strapi: any, effect: () => Promise<unknown>) => { if (active) effects.push(effect); else await effect(); },
  };
});
