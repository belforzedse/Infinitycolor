import type { AdminCapability } from "@repo/auth-core";
import { apiTokenCredentials, requireCapability, resolveAdminActor } from "../../../utils/adminAuthorization";
import { ExportReport, parseExportFilters, ReportExportError } from "../lib/filters";
import { generateReportExport } from "../services/report-export";

export const REPORT_CAPABILITIES: Record<ExportReport, AdminCapability[]> = {
  payments: ["report.excel.export", "report.finance.read"],
  wallet: ["report.excel.export", "report.wallet.export"],
  "inventory-history": ["report.excel.export", "report.inventory-history.export"],
  orders: ["report.excel.export", "report.sales.read", "order.financial.read"],
  "product-buyers": ["report.excel.export", "report.sales.read", "order.financial.read"],
};

export function createReportExportController(strapi: any) {
  const action = (report: ExportReport) => async (ctx: any) => {
    // The shared capability helper also supports synthetic service actors.
    // This system is restricted to an actual active Superadmin user.
    const actor = apiTokenCredentials(ctx) ? null : await resolveAdminActor(strapi, ctx.state?.user);
    if (!actor || actor.role !== "superadmin") {
      ctx.status = 403;
      ctx.body = { data: null, error: { status: 403, name: "ForbiddenError", message: "دسترسی به این گزارش مجاز نیست", details: { code: "REPORT_EXPORT_FORBIDDEN" } } };
      return;
    }
    for (const capability of REPORT_CAPABILITIES[report]) {
      if (!(await requireCapability(ctx, strapi, capability))) return;
    }
    try {
      const filters = parseExportFilters(report, ctx.query || {});
      const result = await generateReportExport(strapi, report, filters);
      // Headers and body are set only after the entire ZIP was finalized.
      ctx.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      ctx.set("Content-Disposition", `attachment; filename="${result.filename}"`);
      ctx.set("Cache-Control", "private, no-store");
      ctx.set("X-Report-Row-Count", String(result.rowCount));
      ctx.status = 200;
      ctx.body = result.buffer;
    } catch (error) {
      if (error instanceof ReportExportError) {
        ctx.status = error.status;
        ctx.body = { data: null, error: { status: error.status, name: "ReportExportError", message: error.message, details: { code: error.code } } };
        return;
      }
      strapi.log.error("Report export failed", { report, error: error instanceof Error ? error.message : "Unknown error" });
      ctx.status = 500;
      ctx.body = { data: null, error: { status: 500, name: "ReportExportError", message: "تهیه گزارش انجام نشد؛ دوباره تلاش کنید", details: { code: "REPORT_EXPORT_FAILED" } } };
    }
  };
  return { payments: action("payments"), wallet: action("wallet"), inventoryHistory: action("inventory-history"), orders: action("orders"), productBuyers: action("product-buyers") };
}

export default ({ strapi }: any) => createReportExportController(strapi);
