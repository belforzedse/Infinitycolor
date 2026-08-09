/**
 * Custom router for report APIs
 */

export default {
  routes: [
    {
      method: "GET",
      path: "/reports/liquidity",
      handler: "report.liquidity",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.finance.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/product-sales",
      handler: "report.productSales",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/overview",
      handler: "report.productOverview",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/trends",
      handler: "report.productTrends",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/breakdown",
      handler: "report.productBreakdown",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/performance",
      handler: "report.productPerformance",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/export",
      handler: "report.productExport",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/detail",
      handler: "report.productDetail",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/products/inventory",
      handler: "report.productInventory",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.product.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/sales/breakdown",
      handler: "report.salesBreakdown",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.sales.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/sales/breakdown/export",
      handler: "report.salesBreakdownExport",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.sales.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/overview",
      handler: "report.overview",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.sales.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/funnel",
      handler: "report.behaviorConversion",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/gateway-liquidity",
      handler: "report.gatewayLiquidity",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.finance.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/admin-activity",
      handler: "report.adminActivity",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "system.audit.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/admin-activity/:id",
      handler: "report.adminActivityById",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "system.audit.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/traffic/dashboard",
      handler: "report.behaviorOverview",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/traffic/realtime",
      handler: "report.behaviorRealtime",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/overview",
      handler: "report.behaviorOverview",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/acquisition",
      handler: "report.behaviorAcquisition",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/conversion",
      handler: "report.behaviorConversion",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/content",
      handler: "report.behaviorContent",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/audience",
      handler: "report.behaviorAudience",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/performance",
      handler: "report.behaviorPerformance",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
    {
      method: "GET",
      path: "/reports/behavior/realtime",
      handler: "report.behaviorRealtime",
      config: {
        auth: { scope: [] },
        policies: [
          { name: "global::require-capability", config: { capability: "report.traffic.read" } },
        ],
      },
    },
  ],
};
