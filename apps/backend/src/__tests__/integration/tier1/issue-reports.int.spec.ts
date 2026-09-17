import { randomUUID } from "node:crypto";

import {
  createIssueReport,
  findIssueReport,
  queryIssueReports,
  updateIssueReportStatus,
  type CreateIssueReportInput,
} from "../../../api/issue-report/services/issue-report";
import { setupStrapi, teardownStrapi } from "../strapiInstance";

const TABLE = "issue_reports";
const REQUIRED_INDEXES = [
  "uq_issue_reports_public_id",
  "uq_issue_reports_submission_id",
  "idx_issue_reports_created_id",
  "idx_issue_reports_status_created_id",
  "idx_issue_reports_contact_prefix",
  "idx_issue_reports_issue_name_trgm",
];

let strapi: any;

function input(overrides: Partial<CreateIssueReportInput> = {}): CreateIssueReportInput {
  return {
    submissionId: randomUUID(),
    contactNumber: "+989121234567",
    issueName: "گزارش هم‌زمان",
    description: "متن گزارش برای آزمون پایگاه داده",
    sourcePath: "/products/integration-test",
    locale: "fa-IR",
    context: {
      clientTime: new Date().toISOString(),
      timeZone: "Asia/Tehran",
      language: "fa-IR",
      viewport: { width: 390, height: 844 },
      screen: { width: 390, height: 844, pixelRatio: 3 },
      online: true,
      connectionType: "4g",
    },
    ...overrides,
  };
}

function percentile(samples: number[], ratio: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))] || 0;
}

beforeAll(async () => {
  process.env.ISSUE_REPORT_MAX_IN_FLIGHT = "3";
  strapi = await setupStrapi();
  await strapi.db.connection(TABLE).delete();
});

afterAll(async () => {
  await teardownStrapi();
});

describe("issue reports on isolated PostgreSQL", () => {
  it("installs the constraints and indexes used by ingestion and the inbox", async () => {
    const indexes = await strapi.db
      .connection("pg_indexes")
      .where({ schemaname: strapi.db.connection.raw("current_schema()"), tablename: TABLE })
      .pluck("indexname");
    expect(indexes).toEqual(expect.arrayContaining(REQUIRED_INDEXES));
  });

  it("atomically collapses simultaneous retries into one durable report", async () => {
    const same = input();
    process.env.ISSUE_REPORT_MAX_IN_FLIGHT = "100";
    let results: Awaited<ReturnType<typeof createIssueReport>>[] = [];
    try {
      results = await Promise.all(
        Array.from({ length: 40 }, () => createIssueReport(strapi, same, {})),
      );
    } finally {
      process.env.ISSUE_REPORT_MAX_IN_FLIGHT = "3";
    }
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    expect(results.filter((result) => result.replayed)).toHaveLength(39);
    expect(new Set(results.map((result) => result.reportId)).size).toBe(1);
    const count = await strapi.db
      .connection(TABLE)
      .where({ submission_id: same.submissionId })
      .count("id as count")
      .first();
    expect(Number(count.count)).toBe(1);
  });

  it("rejects overflow predictably instead of opening unbounded database writes", async () => {
    process.env.ISSUE_REPORT_MAX_IN_FLIGHT = "1";
    const first = input({ issueName: "ظرفیت اول" });
    const second = input({ issueName: "ظرفیت دوم" });
    let results: PromiseSettledResult<Awaited<ReturnType<typeof createIssueReport>>>[] = [];
    try {
      results = await Promise.allSettled([
        createIssueReport(strapi, first, {}),
        createIssueReport(strapi, second, {}),
      ]);
    } finally {
      process.env.ISSUE_REPORT_MAX_IN_FLIGHT = "3";
    }

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect(rejected.reason).toEqual(
      expect.objectContaining({ code: "ISSUE_REPORT_BUSY", status: 503 }),
    );
  });

  it("persists distinct reports in bounded concurrent waves while serving inbox reads", async () => {
    const attempts = 120;
    const samples: number[] = [];
    const inputs = Array.from({ length: attempts }, (_, index) =>
      input({
        issueName: `مشکل fixture-${index}`,
        contactNumber: `+98912${String(index).padStart(7, "0")}`,
      }),
    );

    for (let offset = 0; offset < inputs.length; offset += 3) {
      const wave = inputs.slice(offset, offset + 3).map(async (item) => {
        const started = performance.now();
        const result = await createIssueReport(strapi, item, {});
        samples.push(performance.now() - started);
        return result;
      });
      const [, page] = await Promise.all([
        Promise.all(wave),
        queryIssueReports(strapi, { limit: 25 }),
      ]);
      expect(page.items.length).toBeLessThanOrEqual(25);
    }

    const stored = await strapi.db
      .connection(TABLE)
      .whereIn(
        "submission_id",
        inputs.map((item) => item.submissionId),
      )
      .count("id as count")
      .first();
    expect(Number(stored.count)).toBe(attempts);

    const firstPage = await queryIssueReports(strapi, { limit: 25, status: "new" });
    const secondPage = await queryIssueReports(strapi, {
      limit: 25,
      status: "new",
      cursor: firstPage.nextCursor || undefined,
    });
    expect(firstPage.hasMore).toBe(true);
    expect(new Set(firstPage.items.map((item) => item.reportId)).size).toBe(firstPage.items.length);
    expect(
      secondPage.items.some((item) =>
        firstPage.items.some((first) => first.reportId === item.reportId),
      ),
    ).toBe(false);

    const byTitle = await queryIssueReports(strapi, { search: "fixture-17" });
    expect(byTitle.items).toHaveLength(1);
    expect(byTitle.items[0].issueName).toBe("مشکل fixture-17");

    const byPhone = await queryIssueReports(strapi, { search: "09120000017" });
    expect(byPhone.items).toHaveLength(1);
    expect(byPhone.items[0].contactNumber).toBe("+989120000017");

    const byId = await queryIssueReports(strapi, { search: firstPage.items[0].reportId });
    expect(byId.items.map((item) => item.reportId)).toEqual([firstPage.items[0].reportId]);

    console.log(
      JSON.stringify({
        subsystem: "issue-reports",
        attempts,
        accepted: Number(stored.count),
        failures: attempts - Number(stored.count),
        lostWrites: attempts - Number(stored.count),
        duplicateSubmissionIds: 0,
        concurrency: 3,
        latencyMs: {
          p50: Math.round(percentile(samples, 0.5) * 100) / 100,
          p95: Math.round(percentile(samples, 0.95) * 100) / 100,
          p99: Math.round(percentile(samples, 0.99) * 100) / 100,
        },
      }),
    );
  });

  it("returns context in detail and protects concurrent status changes", async () => {
    const created = await createIssueReport(strapi, input({ issueName: "گزارش وضعیت" }), {
      userAgent: "Integration Browser/1.0",
      reporterUserId: 42,
    });
    const detail = await findIssueReport(strapi, created.reportId);
    expect(detail).toEqual(
      expect.objectContaining({
        userAgent: "Integration Browser/1.0",
        reporterUserId: 42,
        clientContext: expect.objectContaining({ timeZone: "Asia/Tehran" }),
      }),
    );

    const actor = {
      user: { id: 9001, email: "superadmin@test.invalid" },
      role: "superadmin",
      capabilities: ["system.issueReports.manage"],
    } as any;
    const results = await Promise.all([
      updateIssueReportStatus(strapi, created.reportId, "in_review", 1, actor),
      updateIssueReportStatus(strapi, created.reportId, "resolved", 1, actor),
    ]);
    expect(results.filter((result) => result.kind === "success")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "conflict")).toHaveLength(1);
    const audit = await strapi.db
      .connection("manual_admin_activities")
      .where({ event_key: "issue_reports.status_changed", target_id: created.reportId })
      .first("changes");
    expect(audit).toBeTruthy();
  });

  it("persists Instagram-length user agents and titles over 255 characters", async () => {
    const userAgent = `Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Instagram ${"x".repeat(400)}`;
    const issueName = "مرجوعی لباس ".repeat(20).trim();
    expect(userAgent.length).toBeGreaterThan(255);
    expect(issueName.length).toBeGreaterThan(120);
    const created = await createIssueReport(strapi, input({ issueName }), { userAgent });
    const detail = await findIssueReport(strapi, created.reportId);
    expect(detail?.userAgent).toBe(userAgent);
    expect(detail?.issueName).toBe(issueName);
  });

  it("uses the intended indexes for high-volume inbox access patterns", async () => {
    await strapi.db.connection.transaction(async (trx: any) => {
      await trx.raw("SET LOCAL enable_seqscan = off");
      const statusPlan = await trx.raw(
        `EXPLAIN (FORMAT TEXT) SELECT id FROM ${TABLE} WHERE status = 'new' ORDER BY created_at DESC, id DESC LIMIT 25`,
      );
      const titlePlan = await trx.raw(
        `EXPLAIN (FORMAT TEXT) SELECT id FROM ${TABLE} WHERE issue_name ILIKE '%fixture-17%' LIMIT 25`,
      );
      const phonePlan = await trx.raw(
        `EXPLAIN (FORMAT TEXT) SELECT id FROM ${TABLE} WHERE contact_number LIKE '+98912%' LIMIT 25`,
      );
      const plans = {
        status: statusPlan.rows.map((row: any) => row["QUERY PLAN"]).join("\n"),
        title: titlePlan.rows.map((row: any) => row["QUERY PLAN"]).join("\n"),
        phone: phonePlan.rows.map((row: any) => row["QUERY PLAN"]).join("\n"),
      };
      expect(plans.status).toContain("idx_issue_reports_status_created_id");
      expect(plans.title).toContain("idx_issue_reports_issue_name_trgm");
      expect(plans.phone).toContain("idx_issue_reports_contact_prefix");
    });
  });
});
