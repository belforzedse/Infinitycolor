/** Shared types for the product-intelligence workspace endpoints (/reports/products/*). */

export interface Delta {
  current: number;
  previous: number;
  change: number;
  changePct: number | null;
}

export interface ProductOverview {
  range: { start: string; end: string };
  previous: { start: string; end: string };
  timezone: string;
  lowStockThreshold: number;
  kpis: {
    gross: Delta;
    net: Delta;
    units: Delta;
    orders: Delta;
    avgPrice: Delta;
    aov: Delta;
    discounts: Delta;
    refunds: Delta;
  };
  inventory: {
    activeProducts: number;
    inStock: number;
    lowStock: number;
    outStock: number;
    totalVariations: number;
  };
  notes: Record<string, string>;
}

export type TrendGrouping = "day" | "week" | "month";

export interface TrendPoint {
  bucket: string;
  gross: number;
  net: number;
  units: number;
  orders: number;
  discounts: number;
  refunds: number;
}

/**
 * Which order population the series describes. `settled` requires a successful
 * gateway transaction; `completed` counts delivered orders and is used when the
 * window has no settlement rows at all (e.g. WordPress-imported orders).
 */
export type PaidOrdersDefinition = "settled" | "completed";

export interface ProductTrends {
  range: { start: string; end: string };
  grouping: TrendGrouping;
  timezone: string;
  ordersDefinition: PaidOrdersDefinition;
  series: TrendPoint[];
}

export type StockStatus = "in" | "low" | "out" | "unknown";

/** One attribute of a variation, e.g. { name: "جنس", value: "نخی" }. */
export interface VariantAttribute {
  name: string | null;
  value: string | null;
  colorCode: string | null;
  projection: "None" | "Color" | "Size" | "Model";
}

/**
 * What distinguishes one variation of a product from another.
 *
 * Reports are variant-grained, and a bare SKU code is not readable — staff could
 * not tell two rows of the same product apart. `variantOther` carries the custom
 * attributes that have no dedicated column.
 */
export interface VariantIdentity {
  variantColor: string | null;
  variantColorCode: string | null;
  variantSize: string | null;
  variantModel: string | null;
  variantOther: string | null;
  /** `رنگ / سایز / مدل`, blanks dropped; null when the variation has no attributes. */
  variantLabel: string | null;
}

export interface ProductPerformanceRow extends VariantIdentity {
  productVariationId: number | null;
  productId: number | null;
  productTitle: string;
  productSKU: string;
  productType: string | null;
  category: string | null;
  units: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  ordersCount: number;
  avgPrice: number;
  /** THIS variation's stock — not the product's. See `productTotalStock`. */
  currentStock: number | null;
  reservedStock: number | null;
  stockStatus: StockStatus;
  imageUrl?: string | null;
  /** Stock summed across every variation of the product. Null if it has none. */
  productTotalStock: number | null;
  productVariationCount: number | null;
}

export interface ProductPerformanceResult {
  data: ProductPerformanceRow[];
  meta: {
    pagination: { page: number; pageSize: number; total: number; pageCount: number };
    range: { start: string; end: string };
    sort: { column: string; direction: "asc" | "desc" };
    lowStockThreshold: number;
  };
}

export interface GatewayBreakdownRow {
  /** Raw enum value (e.g. "Mellat", "ZarinPal", "Unknown"). */
  gateway: string;
  /** Persian display label. */
  label: string;
  /** Orders that produced a successful settlement. */
  ordersCount: number;
  /**
   * All orders on this gateway in range, settled or not. When this is non-zero
   * while `ordersCount` is 0, the gateway is not writing successful transactions
   * and its revenue is missing from every report — see `dataQualityWarnings`.
   */
  totalOrdersCount: number;
  /** Net successful settlement in Toman. */
  total: number;
  /** Share of total gateway settlement (%), or null when total is 0. */
  sharePct: number | null;
}

/**
 * The gateway table's paid orders split by how many rows each one sits under.
 * Single + mixed partition both the distinct paid orders and the rows' total
 * amount; the row counts sum higher because each mixed order (a wallet +
 * gateway split) is counted under every channel it used.
 */
export interface PaymentMix {
  singleOrdersCount: number;
  /** Toman. */
  singleTotal: number;
  mixedOrdersCount: number;
  /** Toman: the mixed orders' whole net settlement, every leg. */
  mixedTotal: number;
}

export interface ShippingBreakdownRow {
  /** Shipping method title, or "نامشخص" for missing/legacy values. */
  method: string;
  ordersCount: number;
  /** Total shipping fee earned in Toman (from order.ShippingCost). */
  total: number;
}

/**
 * A report-integrity problem detected server-side. Rendered as a visible warning
 * rather than letting the affected figure read as a confident zero.
 */
export interface DataQualityWarning {
  code: string;
  gateway: string;
  message: string;
  ordersCount: number;
}

export interface ProductBreakdown {
  range: { start: string; end: string };
  currency: string;
  totals: { gatewaySales: number; shippingRevenue: number; ordersCount: number };
  /** Optional: absent against an API older than the field. */
  paymentMix?: PaymentMix;
  gateways: GatewayBreakdownRow[];
  shippingMethods: ShippingBreakdownRow[];
  dataQualityWarnings?: DataQualityWarning[];
  notes: Record<string, string>;
}

export interface ProductReportFilters {
  start?: string;
  end?: string;
  q?: string;
  productType?: "Simple" | "Variable" | "";
  categoryId?: number | "";
  stockStatus?: "in" | "low" | "out" | "";
}

export interface VariationDetailRow extends VariantIdentity {
  variantAttrs: VariantAttribute[];
  variationId: number;
  sku: string;
  units: number;
  gross: number;
  discounts: number;
  refunds: number;
  net: number;
  currentStock: number | null;
  reservedStock: number | null;
  stockStatus: StockStatus;
}

export interface ProductDetail {
  product: {
    id: number;
    title: string;
    productType: string | null;
    status: string | null;
    category: string | null;
  };
  range: { start: string; end: string };
  grouping: TrendGrouping;
  timezone: string;
  totals: {
    units: number;
    gross: number;
    discounts: number;
    refunds: number;
    net: number;
    currentStock: number;
  };
  variations: VariationDetailRow[];
  trend: Array<{ bucket: string; gross: number; units: number }>;
}

export interface InventoryRow extends VariantIdentity {
  variationId: number;
  productId: number;
  sku: string;
  productTitle: string;
  currentStock: number;
  reservedStock: number;
  unitsSold: number;
  gross: number;
  daysOfCover: number | null;
  stockStatus: StockStatus;
}

export interface ProductInventory {
  range: { start: string; end: string };
  windowDays: number;
  lowStockThreshold: number;
  timezone: string;
  outOfStock: InventoryRow[];
  lowStock: InventoryRow[];
  stockNoSales: InventoryRow[];
  fastMoving: InventoryRow[];
  slowMoving: InventoryRow[];
}
