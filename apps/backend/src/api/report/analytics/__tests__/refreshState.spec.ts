import {
  getRefreshState,
  markRunFailed,
  markRunStarted,
  markRunSucceeded,
} from "../sources/refreshState";

function fakeKnex(handler: (sql: string, bindings: any[]) => any) {
  const raw = jest.fn(async (sql: string, bindings: any[] = []) => handler(sql, bindings));
  return { raw };
}

describe("analytics_refresh_state watermark bookkeeping", () => {
  it("getRefreshState: returns null when no row exists yet", async () => {
    const knex = fakeKnex(() => ({ rows: [] }));
    const state = await getRefreshState(knex, "analytics_daily_rollup");
    expect(state).toBeNull();
  });

  it("getRefreshState: parses the stored row", async () => {
    const knex = fakeKnex(() => ({
      rows: [
        {
          source_type: "analytics_daily_rollup",
          watermark: "2026-05-04T00:00:00.000Z",
          last_run_at: "2026-05-05T00:20:00.000Z",
          last_status: "success",
          last_error: null,
        },
      ],
    }));

    const state = await getRefreshState(knex, "analytics_daily_rollup");

    expect(state).toEqual({
      sourceType: "analytics_daily_rollup",
      watermark: new Date("2026-05-04T00:00:00.000Z"),
      lastRunAt: new Date("2026-05-05T00:20:00.000Z"),
      lastStatus: "success",
      lastError: null,
    });
  });

  it("markRunStarted: upserts a 'running' row without touching the watermark", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [] };
    });

    await markRunStarted(knex, "analytics_daily_rollup");

    expect(calls[0].sql).toContain("'running'");
    expect(calls[0].sql).toContain("ON CONFLICT (source_type) DO UPDATE");
    expect(calls[0].sql).not.toContain("watermark = EXCLUDED.watermark");
    expect(calls[0].bindings).toEqual(["analytics_daily_rollup"]);
  });

  it("markRunSucceeded: upserts the new watermark and clears any prior error", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [] };
    });
    const watermark = new Date("2026-05-10T00:00:00.000Z");

    await markRunSucceeded(knex, "analytics_daily_rollup", watermark);

    expect(calls[0].sql).toContain("'success'");
    expect(calls[0].sql).toContain("watermark = EXCLUDED.watermark");
    expect(calls[0].bindings).toEqual(["analytics_daily_rollup", watermark]);
  });

  it("markRunFailed: records the error without advancing the watermark, truncated to 4000 chars", async () => {
    const calls: Array<{ sql: string; bindings: any[] }> = [];
    const knex = fakeKnex((sql, bindings) => {
      calls.push({ sql, bindings });
      return { rows: [] };
    });
    const longError = "x".repeat(5000);

    await markRunFailed(knex, "analytics_daily_rollup", longError);

    expect(calls[0].sql).toContain("'failed'");
    expect(calls[0].sql).not.toContain("watermark");
    expect(calls[0].bindings[0]).toBe("analytics_daily_rollup");
    expect((calls[0].bindings[1] as string).length).toBe(4000);
  });
});
