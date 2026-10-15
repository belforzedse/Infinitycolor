const requireCapabilityMock = jest.fn();
const generateReportExportMock = jest.fn();
const resolveAdminActorMock = jest.fn();
const apiTokenCredentialsMock = jest.fn();
jest.mock("../../../utils/adminAuthorization", () => ({ requireCapability: (...args: any[]) => requireCapabilityMock(...args), resolveAdminActor: (...args: any[]) => resolveAdminActorMock(...args), apiTokenCredentials: (...args: any[]) => apiTokenCredentialsMock(...args) }));
jest.mock("../services/report-export", () => ({ generateReportExport: (...args: any[]) => generateReportExportMock(...args) }));
import { createReportExportController } from "../controllers/report-export";
import routes from "../routes/report-export";
import { ReportExportError } from "../lib/filters";

const context = () => ({ state: { user: { id: 1 } } as any, query: { start: "2026-09-14", end: "2026-09-14" }, set: jest.fn(), status: 0, body: undefined as any });
describe("export authorization and response", () => {
  const strapi = { log: { error: jest.fn() } };
  beforeEach(() => { jest.clearAllMocks(); apiTokenCredentialsMock.mockReturnValue(null); resolveAdminActorMock.mockResolvedValue({ role: "superadmin", user: { id: 1 } }); requireCapabilityMock.mockResolvedValue({ id: 1 }); generateReportExportMock.mockResolvedValue({ buffer: Buffer.from("PKfixture"), rowCount: 0, filename: "infinitycolor-orders.xlsx" }); });
  it.each(["finance", "founder"])("denies the actual %s role even if a cached actor or capabilities claim Superadmin", async (role) => {
    const ctx = context(); ctx.state.adminActor = { role: "superadmin" };
    resolveAdminActorMock.mockResolvedValue({ role, user: { id: 1 } });
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(403); expect(requireCapabilityMock).not.toHaveBeenCalled(); expect(generateReportExportMock).not.toHaveBeenCalled();
  });
  it("rejects full-access API tokens without resolving or trusting a synthetic actor", async () => {
    const ctx = context(); apiTokenCredentialsMock.mockReturnValue({ type: "full-access" });
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(403); expect(resolveAdminActorMock).not.toHaveBeenCalled(); expect(generateReportExportMock).not.toHaveBeenCalled();
  });
  it("rejects a trusted migration synthetic actor without an actual active Superadmin user", async () => {
    const ctx = context(); ctx.state = { adminActor: { role: "superadmin", user: { username: "wordpress-migration" } } };
    resolveAdminActorMock.mockResolvedValue(null);
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(403); expect(requireCapabilityMock).not.toHaveBeenCalled(); expect(generateReportExportMock).not.toHaveBeenCalled();
  });
  it("requires both sales and financial access before reading customer/order money", async () => {
    const ctx = context(); requireCapabilityMock.mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce({ id: 1 }).mockResolvedValueOnce(null);
    await createReportExportController(strapi).orders(ctx);
    expect(requireCapabilityMock.mock.calls.map((args) => args[2])).toEqual(["report.excel.export", "report.sales.read", "order.financial.read"]);
    expect(generateReportExportMock).not.toHaveBeenCalled(); expect(ctx.set).not.toHaveBeenCalled();
  });
  it.each(["payments", "wallet", "inventoryHistory", "orders", "productBuyers"])("denies %s before reading or writing the response", async (action) => {
    requireCapabilityMock.mockResolvedValue(null); const ctx = context();
    await (createReportExportController(strapi) as any)[action](ctx);
    expect(generateReportExportMock).not.toHaveBeenCalled(); expect(ctx.set).not.toHaveBeenCalled();
  });
  it("returns the finalized file with a reliable empty-result header and no-store", async () => {
    const ctx = context(); await createReportExportController(strapi).orders(ctx);
    expect(ctx.status).toBe(200); expect(Buffer.isBuffer(ctx.body)).toBe(true);
    expect(ctx.set).toHaveBeenCalledWith("X-Report-Row-Count", "0");
    expect(ctx.set).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(ctx.set).toHaveBeenCalledWith("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(ctx.set).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="infinitycolor-orders.xlsx"');
  });
  it("rejects filters without generating a file", async () => {
    const ctx = context(); (ctx.query as any).token = "secret";
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(400); expect(ctx.body.error.details.code).toBe("INVALID_EXPORT_FILTERS");
    expect(generateReportExportMock).not.toHaveBeenCalled(); expect(ctx.set).not.toHaveBeenCalled();
  });
  it("returns 413 without a partial workbook", async () => {
    const ctx = context(); generateReportExportMock.mockRejectedValue(new ReportExportError("REPORT_TOO_LARGE", 413, "زیاد"));
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(413); expect(ctx.body.error.details.code).toBe("REPORT_TOO_LARGE"); expect(ctx.set).not.toHaveBeenCalled();
  });
  it("does not expose backend/provider errors or a partial XLSX on failure", async () => {
    const ctx = context(); generateReportExportMock.mockRejectedValue(new Error("provider token=private"));
    await createReportExportController(strapi).payments(ctx);
    expect(ctx.status).toBe(500); expect(JSON.stringify(ctx.body)).not.toContain("private"); expect(ctx.set).not.toHaveBeenCalled();
  });
  it("gates all routes with authenticated capability policies, including financial access", () => {
    for (const route of routes.routes) {
      expect(route.config.auth).toEqual({ scope: [] });
      expect(route.config.policies[0].config.capability).toBe("report.excel.export");
      expect(route.config.policies.every((policy) => policy.name === "global::require-capability")).toBe(true);
      expect(route.config.policies.some((policy) => policy.config.capability === "system.audit.read")).toBe(false);
    }
    expect(routes.routes.filter((route) => /orders|product-buyers/.test(route.path)).every((route) => route.config.policies.some((policy) => policy.config.capability === "order.financial.read"))).toBe(true);
  });
});
