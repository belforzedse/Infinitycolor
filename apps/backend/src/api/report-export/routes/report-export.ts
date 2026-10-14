import { REPORT_CAPABILITIES } from "../controllers/report-export";
import type { ExportReport } from "../lib/filters";

const actions: [ExportReport, string][] = [["payments", "payments"], ["wallet", "wallet"], ["inventory-history", "inventoryHistory"], ["orders", "orders"], ["product-buyers", "productBuyers"]];
export default {
  routes: actions.map(([report, action]) => ({
    method: "GET", path: `/reports/exports/${report}`, handler: `report-export.${action}`,
    config: { auth: { scope: [] }, policies: REPORT_CAPABILITIES[report].map((capability) => ({ name: "global::require-capability", config: { capability } })) },
  })),
};
