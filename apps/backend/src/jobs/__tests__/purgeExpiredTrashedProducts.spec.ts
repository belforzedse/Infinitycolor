const mockPurge = jest.fn();
jest.mock("../../api/product/services/product-lifecycle", () => ({
  purgeProductInTransaction: (...args: unknown[]) => mockPurge(...args),
}));
jest.mock("../../api/product/services/product-publication", () => {
  class PublicationCommandError extends Error {
    code: string;
    status: number;
    constructor(code: string, status = 400) {
      super(code);
      this.code = code;
      this.status = status;
    }
  }
  return { PublicationCommandError };
});

import { PublicationCommandError } from "../../api/product/services/product-publication";
import { runTrashRetentionSweep } from "../purgeExpiredTrashedProducts";
import {
  purgeDueAt,
  readTrashRetentionConfig,
  retentionCutoff,
} from "../../api/product/services/product-trash-retention";

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-09-27T00:00:00.000Z");

function makeStrapi(opts: { rows?: Array<{ id: number }>; enabledSince?: string | null } = {}) {
  const selects: any[] = [];
  const pending = [...(opts.rows || [])];
  const connection = jest.fn(() => {
    const query: any = { calls: [] as unknown[][] };
    for (const method of ["select", "whereNotNull", "whereNull", "where", "whereNotIn", "orderBy", "limit"]) {
      query[method] = jest.fn((...args: unknown[]) => {
        query.calls.push([method, ...args]);
        return query;
      });
    }
    query.then = (resolve: any) => {
      const excluded = new Set(
        (query.calls.find((call: unknown[]) => call[0] === "whereNotIn")?.[2] as number[]) || [],
      );
      return Promise.resolve(pending.filter((row) => !excluded.has(row.id))).then(resolve);
    };
    selects.push(query);
    return query;
  });
  const stored: Record<string, unknown> = { enabledSince: opts.enabledSince ?? null };
  const store = {
    get: jest.fn(async ({ key }: { key: string }) => stored[key] ?? null),
    set: jest.fn(async ({ key, value }: { key: string; value: unknown }) => {
      stored[key] = value;
    }),
  };
  return {
    strapi: {
      db: { connection },
      store: jest.fn(() => store),
      log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
    } as any,
    selects,
    store,
  };
}

describe("trash retention policy", () => {
  it.each([
    [undefined, { enabled: false, reason: "disabled" }],
    ["", { enabled: false, reason: "disabled" }],
    ["0", { enabled: false, reason: "disabled" }],
    ["30", { enabled: true, days: 30 }],
    ["-5", { enabled: false, reason: "invalid", raw: "-5" }],
    ["30d", { enabled: false, reason: "invalid", raw: "30d" }],
    ["99999", { enabled: false, reason: "invalid", raw: "99999" }],
  ])("reads %j", (value, expected) => {
    expect(
      readTrashRetentionConfig(value === undefined ? {} : { PRODUCT_TRASH_RETENTION_DAYS: value }),
    ).toEqual(expected);
  });

  it("starts the clock at enablement for trash older than that", () => {
    const enabled = new Date("2026-09-01T00:00:00.000Z");
    expect(purgeDueAt(new Date("2026-01-01T00:00:00.000Z"), enabled, 30).toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
    expect(purgeDueAt(new Date("2026-09-10T00:00:00.000Z"), enabled, 30).toISOString()).toBe(
      "2026-10-10T00:00:00.000Z",
    );
  });

  it("has no cut-off until a full period has passed since enablement", () => {
    expect(retentionCutoff(now, new Date(now.getTime() - 10 * DAY), 30)).toBeNull();
    expect(retentionCutoff(now, new Date(now.getTime() - 31 * DAY), 30)?.toISOString()).toBe(
      new Date(now.getTime() - 30 * DAY).toISOString(),
    );
  });
});

describe("trash retention sweep", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does nothing while retention is off", async () => {
    const { strapi, selects } = makeStrapi({ rows: [{ id: 1 }] });
    await expect(runTrashRetentionSweep(strapi, { now, env: {} })).resolves.toEqual(
      expect.objectContaining({ status: "disabled", purged: 0 }),
    );
    expect(selects).toHaveLength(0);
    expect(mockPurge).not.toHaveBeenCalled();
  });

  it("never deletes on a malformed setting and says so", async () => {
    const { strapi, selects } = makeStrapi({ rows: [{ id: 1 }] });
    await expect(
      runTrashRetentionSweep(strapi, { now, env: { PRODUCT_TRASH_RETENTION_DAYS: "thirty" } }),
    ).resolves.toEqual(expect.objectContaining({ status: "invalid-config" }));
    expect(selects).toHaveLength(0);
    expect(strapi.log.error).toHaveBeenCalled();
  });

  it("records enablement on the first run and sweeps nothing of the old backlog", async () => {
    const { strapi, selects, store } = makeStrapi({ rows: [{ id: 1 }], enabledSince: null });
    await expect(
      runTrashRetentionSweep(strapi, { now, env: { PRODUCT_TRASH_RETENTION_DAYS: "30" } }),
    ).resolves.toEqual(expect.objectContaining({ status: "not-due" }));
    expect(store.set).toHaveBeenCalledWith({ key: "enabledSince", value: now.toISOString() });
    expect(selects).toHaveLength(0);
  });

  it("purges only what is due, under the cut-off it selected with", async () => {
    const { strapi, selects } = makeStrapi({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      enabledSince: "2026-01-01T00:00:00.000Z",
    });
    mockPurge
      .mockResolvedValueOnce({ changed: true })
      .mockRejectedValueOnce(new PublicationCommandError("PRODUCT_NOT_IN_TRASH", 409))
      .mockResolvedValueOnce({ changed: false });

    const summary = await runTrashRetentionSweep(strapi, {
      now,
      env: { PRODUCT_TRASH_RETENTION_DAYS: "30" },
    });

    const cutoff = new Date(now.getTime() - 30 * DAY);
    expect(summary).toEqual(
      expect.objectContaining({ status: "completed", scanned: 3, purged: 1, skipped: 2, failed: 0 }),
    );
    expect(mockPurge).toHaveBeenCalledWith(
      strapi,
      1,
      expect.objectContaining({ origin: "retention" }),
      { trashedBefore: cutoff },
    );
    const firstSelect = selects[0].calls;
    expect(firstSelect).toContainEqual(["whereNotNull", "removed_at"]);
    expect(firstSelect).toContainEqual(["whereNull", "purged_at"]);
    expect(firstSelect).toContainEqual(["where", "removed_at", "<=", cutoff]);
  });

  it("keeps going past a failing product and reports it", async () => {
    const { strapi } = makeStrapi({ rows: [{ id: 1 }, { id: 2 }], enabledSince: "2026-01-01T00:00:00.000Z" });
    mockPurge.mockRejectedValueOnce(new Error("deadlock")).mockResolvedValueOnce({ changed: true });

    const summary = await runTrashRetentionSweep(strapi, {
      now,
      env: { PRODUCT_TRASH_RETENTION_DAYS: "30" },
    });

    expect(summary).toEqual(expect.objectContaining({ purged: 1, failed: 1 }));
    expect(strapi.log.error).toHaveBeenCalled();
  });
});
