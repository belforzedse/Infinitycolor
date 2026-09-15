import { findIssueReport } from "../services/issue-report";

function chain(result: unknown) {
  const rows = Array.isArray(result) ? result : result == null ? [] : [result];
  const builder: any = {
    where: jest.fn(() => builder),
    join: jest.fn(() => builder),
    orderBy: jest.fn(() => builder),
    select: jest.fn(() => Promise.resolve(rows)),
    first: jest.fn(() => Promise.resolve(rows[0] ?? null)),
  };
  return builder;
}

const reportRow = {
  public_id: "8a6e1c7d-4ef6-4d7d-afda-9999210d5514",
  contact_number: "+989121234567",
  issue_name: "جزئیات سفارشم بعد ثبت مشخص نمیشه",
  description: "سلام وقت بخیر جزئیات سفارشم بعد ثبت مشخص نمیشه",
  status: "new",
  source_path: "/payment/result",
  reporter_user_id: 29283,
  user_agent: "Chrome/152.0.0.0",
  version: 1,
  created_at: "2026-09-15T09:24:35.025Z",
  updated_at: "2026-09-15T09:24:35.025Z",
};

function buildStrapi(connection: jest.Mock) {
  return { db: { connection } } as any;
}

describe("findIssueReport order enrichment", () => {
  it("attaches the reported order's items when the client sent an orderId", async () => {
    const connection = jest.fn((table: string) => {
      if (table === "issue_reports") {
        return chain({
          ...reportRow,
          client_context: { order: { orderId: 111805 } },
        });
      }
      if (table === "orders") {
        return chain({ id: 111805, status: "Started", payment_gateway: "SnappPay", date: "2026-09-15T09:18:42.464Z" });
      }
      if (table === "order_items_order_links as oiol") {
        return chain([
          { id: 158117, product_title: "وست گلدوزی تدی N 0035", product_sku: "WC-1297070-1297075", count: 1, per_amount: "2149000" },
          { id: 158118, product_title: "شلوار جین بگ N 0015", product_sku: "WC-1293833-1293841", count: 1, per_amount: "3699000" },
        ]);
      }
      if (table === "orders_user_links") {
        return chain({ user_id: 29283 });
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const report = await findIssueReport(buildStrapi(connection), reportRow.public_id);

    expect(report?.order).toEqual({
      id: 111805,
      status: "Started",
      paymentGateway: "SnappPay",
      date: "2026-09-15T09:18:42.464Z",
      items: [
        { id: 158117, productTitle: "وست گلدوزی تدی N 0035", productSku: "WC-1297070-1297075", count: 1, perAmount: 2149000 },
        { id: 158118, productTitle: "شلوار جین بگ N 0015", productSku: "WC-1293833-1293841", count: 1, perAmount: 3699000 },
      ],
      reporterMatchesOrder: true,
    });
  });

  it("flags a mismatch when the order belongs to a different account", async () => {
    const connection = jest.fn((table: string) => {
      if (table === "issue_reports") {
        return chain({ ...reportRow, client_context: { order: { orderId: 111805 } } });
      }
      if (table === "orders") {
        return chain({ id: 111805, status: "Started", payment_gateway: "SnappPay", date: null });
      }
      if (table === "order_items_order_links as oiol") return chain([]);
      if (table === "orders_user_links") return chain({ user_id: 999 });
      throw new Error(`unexpected table: ${table}`);
    });

    const report = await findIssueReport(buildStrapi(connection), reportRow.public_id);
    expect(report?.order?.reporterMatchesOrder).toBe(false);
  });

  it("leaves order undefined when the report carries no orderId", async () => {
    const connection = jest.fn((table: string) => {
      if (table === "issue_reports") return chain({ ...reportRow, client_context: {} });
      throw new Error(`unexpected table: ${table}`);
    });

    const report = await findIssueReport(buildStrapi(connection), reportRow.public_id);
    expect(report?.order).toBeUndefined();
    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("does not fail the report fetch when the order lookup errors", async () => {
    const connection = jest.fn((table: string) => {
      if (table === "issue_reports") {
        return chain({ ...reportRow, client_context: { order: { orderId: 111805 } } });
      }
      if (table === "orders") {
        throw new Error("connection reset");
      }
      throw new Error(`unexpected table: ${table}`);
    });

    const report = await findIssueReport(buildStrapi(connection), reportRow.public_id);
    expect(report?.reportId).toBe(reportRow.public_id);
    expect(report?.order).toBeUndefined();
  });

  it("returns no order snapshot when the reported orderId does not exist", async () => {
    const connection = jest.fn((table: string) => {
      if (table === "issue_reports") {
        return chain({ ...reportRow, client_context: { order: { orderId: 999999 } } });
      }
      if (table === "orders") return chain(null);
      throw new Error(`unexpected table: ${table}`);
    });

    const report = await findIssueReport(buildStrapi(connection), reportRow.public_id);
    expect(report?.order).toBeUndefined();
  });
});
