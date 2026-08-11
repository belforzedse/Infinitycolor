jest.mock("../../../../utils/responseCache", () => ({
  delByPatternStrict: jest.fn(),
}));

jest.mock("../../../../utils/revalidate", () => ({
  triggerFrontendRevalidation: jest.fn(),
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
import {
  executePublicationCommand,
  PublicationCommandError,
  publishScheduledProduct,
  recordScheduledPublicationTransientFailure,
  runPublicationEffects,
} from "../product-publication";

const mockedPurge = delByPatternStrict as jest.MockedFunction<typeof delByPatternStrict>;
const mockedRevalidate = triggerFrontendRevalidation as jest.MockedFunction<
  typeof triggerFrontendRevalidation
>;
const mockedWriteAudit = writeAuditEvent as jest.MockedFunction<typeof writeAuditEvent>;

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

function makeStrapi(initialRows: Row[], opts: { cover?: unknown } = {}) {
  const rows = new Map(initialRows.map((row) => [row.id, { ...row }]));

  class Query {
    filters: Array<(row: Row) => boolean> = [];

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

    forUpdate() {
      return this;
    }

    matching() {
      return Array.from(rows.values()).filter((row) => this.filters.every((filter) => filter(row)));
    }

    async first() {
      const row = this.matching()[0];
      return row ? { ...row } : undefined;
    }

    async update(data: Record<string, unknown>) {
      const matches = this.matching();
      matches.forEach((row) => Object.assign(rows.get(row.id)!, data));
      return matches.length;
    }
  }

  const connection = jest.fn((table: string) => {
    expect(table).toBe("products");
    return new Query();
  });
  const trx = (table: string) => connection(table);
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
});
