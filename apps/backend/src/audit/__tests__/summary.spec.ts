import { getAuditSummary } from "../query";

/** A chainable stand-in for the knex builder that records every call and resolves by query shape. */
function fakeKnex() {
  const builders: Array<{ calls: Array<[string, unknown[]]>; raw: string[] }> = [];
  const knex: any = () => {
    const record = { calls: [] as Array<[string, unknown[]]>, raw: [] as string[] };
    builders.push(record);
    const builder: any = new Proxy(
      {},
      {
        get(_, prop: string) {
          if (prop === "then") {
            const text = record.raw.join(" ");
            const rows = text.includes("extract(dow")
              ? [
                  { dow: 5, hour: 23, count: 3 },
                  { dow: 1, hour: 10, count: 2 },
                ]
              : text.includes("as date")
                ? [{ date: "2026-09-20", human: 2, automatic: 5 }]
                : [];
            const value = record.calls.some(([name]) => name === "first")
              ? { total: 7, human: 2, automatic: 5, failed_or_denied: 1, active_admins: 1 }
              : rows;
            return (resolve: (v: unknown) => void) => resolve(value);
          }
          return (...args: unknown[]) => {
            record.calls.push([prop, args]);
            return builder;
          };
        },
      },
    );
    return builder;
  };
  knex.raw = (sql: string) => {
    builders[builders.length - 1]?.raw.push(sql);
    return sql;
  };
  return { knex, builders };
}

describe("audit summary", () => {
  it("adds when admins work: human actions per Tehran weekday and hour, with day counts", async () => {
    const { knex, builders } = fakeKnex();
    const summary = await getAuditSummary({ db: { connection: knex } } as any, {
      // 14–20 Sep 2026 in Tehran: one of each weekday.
      from: "2026-09-13T20:30:00.000Z",
      to: "2026-09-20T20:29:59.999Z",
      mode: "all",
    } as any);

    expect(summary.weekly.counts[5][23]).toBe(3);
    expect(summary.weekly.counts[1][10]).toBe(2);
    expect(summary.weekly.days).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(summary.weekly).toMatchObject({ timezone: "Asia/Tehran", firstDay: "sunday" });

    const weekly = builders.find((builder) => builder.raw.some((sql) => sql.includes("extract(dow")))!;
    expect(weekly.raw.join(" ")).toContain("occurred_at at time zone 'Asia/Tehran'");
    expect(weekly.calls).toContainEqual(["whereIn", ["actor_type", ["human", "impersonated_human"]]]);
    // The window filter applies to the grid like the rest of the summary.
    expect(weekly.calls.filter(([name]) => name === "where").map(([, args]) => args[0])).toEqual(
      expect.arrayContaining(["occurred_at"]),
    );
    expect(summary.series).toEqual([{ date: "2026-09-20", human: 2, automatic: 5 }]);
  });
});
