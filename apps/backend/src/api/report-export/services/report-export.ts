import * as PA from "../../report/services/product-analytics";
import { normalizeOrderSku } from "../../admin-order-list/lib/delivery-search";
import { completeDayAnalyticsSql, ExportFilters, ExportReport, MAX_REPORT_ROWS, ReportExportError, RowBudget } from "../lib/filters";
import { buildWorkbook, ReportColumn, ReportData, ReportSheet } from "../lib/workbook";
import { sumIrr, tomanToIrr } from "../lib/money";
import * as Q from "../lib/queries";
import { inventorySummary, isManualAdjustment, kindLabels, labelProviders, paymentSummary, splitPaymentControl, staffRoleLabel, statusLabels, stockCountChange, walletSummary } from "../lib/semantics";

const col = (key: string, label: string, type: ReportColumn["type"] = "text", width?: number): ReportColumn => ({ key, label, type, width });
const money = (key: string, label: string) => col(key, `${label} (تومان)`, "money");
const count = (key: string, label: string) => col(key, label, "number", 18);
const date = (key: string, label: string) => col(key, `${label} (تهران)`, "date", 26);
const sheet = (name: string, columns: ReportColumn[], rows: any[], detail = false): ReportSheet => ({ name, columns, rows, detail });
/** pg serializes Date in the process timezone; the store keeps UTC naive timestamps. */
export const utcBindings = (bindings: any[]): any[] => bindings.map((value) => value instanceof Date ? value.toISOString() : value);
async function rows(knex: any, query: Q.ReportQuery): Promise<any[]> {
  const result = await knex.raw(query.sql, utcBindings(query.bindings));
  return result?.rows || result?.[0] || [];
}
async function details(knex: any, query: Q.ReportQuery, budget: RowBudget): Promise<any[]> {
  const result = await rows(knex, query);
  budget.consume(result);
  return result;
}
const orderNotes = ["قیمت اقلام، هزینه ارسال و تخفیف از مقادیر ثبت‌شده سفارش گرفته شده‌اند. مبالغ پرداخت و بازگشت وجه از تراکنش‌های موفق‌اند.", "مبلغ سفارش در برگه سفارش‌ها یک بار آمده است؛ برگه اقلام فقط مبلغ هر قلم را دارد."];

export async function loadReportData(knex: any, report: ExportReport, filters: ExportFilters): Promise<ReportData> {
  const joins = await PA.resolveJoins(knex), budget = new RowBudget();
  if (report === "payments") {
    const movements = await details(knex, Q.paymentsQuery(joins, filters), budget);
    const splits = await details(knex, Q.splitPaymentsQuery(joins, filters), budget);
    const end = filters.endExclusive!;
    const analyticsKnex = { raw: (sql: string, bindings: any[]) => knex.raw(completeDayAnalyticsSql(sql), utcBindings(bindings)) };
    const definition = await PA.resolvePaidOrdersDefinition(analyticsKnex as any, joins, filters.startAt!, end, "settlement");
    const reconciliation = await rows(knex, { sql: completeDayAnalyticsSql(PA.gatewayBreakdownQuery(joins, definition, "settlement")), bindings: [filters.startAt, end, filters.startAt, end] });
    const first = reconciliation[0] || {};
    const summary = paymentSummary(movements);
    if (!summary.length) summary.push({ provider: "همه", kind: "همه", evidence: "بدون گردش", count: 0, amount_irr: BigInt(0), cash_irr: BigInt(0) });
    return { rowCount: budget.count, notes: [
      "گردش‌ها بر اساس تاریخ تراکنش‌اند و پرداخت سفارش‌های لغوشده را هم شامل می‌شوند.",
      "بازگشت وجه به کیف پول، خروج وجه از بانک نیست. اسناد کیف پول فقط با شناسه مرجع دقیق به تراکنش متناظر پیوند می‌خورند.",
      "برگه تطبیق داشبورد، کل بازه را با تعریف فروش داشبورد نشان می‌دهد؛ فیلتر درگاه، نوع تراکنش و وضعیت روی آن اعمال نمی‌شود.",
      "تعداد سفارش یکتا با تعداد انتساب به درگاه متفاوت است؛ سفارش دارای چند روش پرداخت در چند درگاه دیده می‌شود.",
      "در برگه پرداخت ترکیبی، سفارش با فیلتر گردش انتخاب شده و همه پرداخت‌ها و بازگشت‌های موفق آن نشان داده می‌شوند. کنترل با مبلغ فعلی اقلام سفارش است؛ سهم کیف پول بر پایه پرداخت اولیه محاسبه شده است.",
      ...(movements.some((row) => row.source_id.startsWith("LEDGER:")) ? ["اسناد بدون تراکنش متناظر جداگانه مشخص شده‌اند؛ تطبیق آن‌ها قطعی نیست."] : []),
    ], sheets: [
      sheet("خلاصه گردش", [col("provider", "درگاه"), col("kind", "نوع گردش"), col("evidence", "منبع"), count("count", "تعداد"), money("amount_irr", "مبلغ گردش"), money("cash_irr", "خالص وجه غیرکیف پول")], summary),
      sheet("گردش پرداخت‌ها", [col("source_id", "شناسه سند"), date("date", "تاریخ"), col("order_id", "سفارش"), col("order_status", "وضعیت سفارش"), col("provider", "درگاه"), col("kind", "نوع گردش"), money("amount_irr", "مبلغ"), col("reference", "مرجع"), col("ledger_id", "سند کیف پول"), col("evidence", "منبع", "text", 42)], movements.map((row) => ({ ...row, provider: labelProviders(row.provider), kind: kindLabels[row.kind], order_status: statusLabels[row.order_status] || "" })), true),
      sheet("پرداخت‌های ترکیبی", [col("order_id", "شماره سفارش"), date("date", "تاریخ سفارش"), col("status", "وضعیت"), col("customer_name", "مشتری"), col("phone", "شماره همراه"), col("providers", "روش‌های پرداخت", "text", 40), money("wallet_charges_irr", "پرداخت کیف پول"), money("other_charges_irr", "پرداخت سایر روش‌ها"), col("wallet_share", "سهم کیف پول"), money("wallet_refunds_irr", "بازگشت به کیف پول"), money("other_refunds_irr", "بازگشت سایر روش‌ها"), money("net_irr", "خالص پرداخت"), money("invoice_irr", "مبلغ سفارش"), money("control_irr", "اختلاف"), col("control", "کنترل")], splits.map((row) => ({ ...splitPaymentControl(row), status: statusLabels[row.status], providers: labelProviders(row.providers) })), true),
      sheet("تطبیق داشبورد", [col("provider", "درگاه"), count("orders_count", "انتساب سفارش پرداخت‌شده"), money("settled_irr", "خالص تسویه"), count("total_orders_count", "سفارش ایجادشده")], reconciliation.map((row) => ({ ...row, provider: labelProviders(row.gateway) }))),
      sheet("شمارش یکتای داشبورد", [count("paid", "سفارش واجد شرایط یکتا"), count("attributed", "انتساب به درگاه"), count("single", "تک‌روش"), count("mixed", "چندروش"), col("definition", "مبنای گزارش")], [{ paid: Number(first.paid_orders_count || 0), attributed: reconciliation.reduce((sum, row) => sum + Number(row.orders_count || 0), 0), single: Number(first.single_orders_count || 0), mixed: Number(first.mixed_orders_count || 0), definition: definition === "settled" ? "دارای تسویه موفق" : "سفارش در حال انجام؛ تسویه موفق ثبت نشده" }]),
    ] };
  }
  if (report === "wallet") {
    const ledger = await details(knex, Q.walletQuery(joins, filters), budget);
    const adjustments = ledger.filter(isManualAdjustment);
    // Adjustment rows are a second detail sheet and count toward the workbook limit.
    budget.consume(adjustments);
    const fundedOrders = await details(knex, Q.walletOrdersQuery(joins, filters), budget);
    return { rowCount: budget.count, notes: ["این گزارش گردش ثبت‌شده کیف پول را نشان می‌دهد؛ جمع بازه، موجودی فعلی کیف پول نیست.", "تغییرهای دستی با شناسه سند کیف پول به سوابق کارکنان وصل شده‌اند. نام ثبت‌نشده، نامشخص می‌ماند.", "سفارش‌های کیف پول از برداشت‌های انتخاب‌شده‌اند. پرداخت و بازگشت وجه موفق، همه سوابق سفارش را شامل می‌شوند؛ نوع پرداخت بدون تراکنش موفق کیف پول، نامشخص است."], sheets: [
      sheet("خلاصه", [count("count", "تعداد گردش"), money("credits_irr", "واریز"), money("debits_irr", "برداشت"), money("net_irr", "خالص تغییر"), money("adjustment_credits_irr", "واریز دستی"), money("adjustment_debits_irr", "برداشت دستی")], walletSummary(ledger)),
      sheet("گردش کیف پول", [col("id", "شناسه سند"), date("date", "تاریخ"), col("wallet_id", "کیف پول"), col("customer_id", "شناسه مشتری"), col("customer_name", "نام مشتری"), col("phone", "شماره همراه"), col("direction", "جهت گردش"), money("amount_irr", "مبلغ"), col("order_id", "سفارش مرتبط"), col("reference", "مرجع"), col("cause", "بابت", "text", 40), col("note", "توضیح", "text", 50)], ledger.map((row) => ({ ...row, direction: row.type === "Add" ? "واریز" : "برداشت", cause: walletCause(row.cause) })), true),
      sheet("تغییرهای دستی", [col("id", "شناسه سند کیف پول"), date("date", "تاریخ"), col("customer_name", "مشتری"), col("phone", "شماره همراه"), col("direction", "جهت تغییر"), money("amount_irr", "مبلغ"), money("before_irr", "موجودی قبل"), money("after_irr", "موجودی بعد"), col("actor", "کارمند"), col("actor_role", "نقش"), col("reason", "دلیل", "text", 60)], adjustments.map((row) => ({ ...row, direction: row.type === "Add" ? "واریز" : "برداشت", actor: row.actor || "نامشخص", actor_role: staffRoleLabel(row.actor_role), reason: row.reason || row.note || "" })), true),
      sheet("سفارش‌های کیف پول", [col("order_id", "شماره سفارش"), date("date", "تاریخ سفارش"), col("status", "وضعیت"), col("customer_name", "مشتری"), col("phone", "شماره همراه"), money("period_wallet_irr", "برداشت کیف پول در بازه"), money("wallet_charges_irr", "پرداخت موفق کیف پول"), money("other_charges_irr", "پرداخت موفق سایر روش‌ها"), money("wallet_refunds_irr", "بازگشت به کیف پول"), col("providers", "روش‌های پرداخت", "text", 40), col("payment_kind", "نوع پرداخت")], fundedOrders.map((row) => ({ ...row, status: statusLabels[row.status] || row.status, providers: labelProviders(row.providers), payment_kind: row.wallet_charges_irr == null || BigInt(row.wallet_charges_irr) <= BigInt(0) ? "نامشخص" : BigInt(row.other_charges_irr || 0) > BigInt(0) ? "بخشی با کیف پول" : "کامل با کیف پول" })), true),
    ] };
  }
  if (report === "orders") {
    const orders = await details(knex, Q.ordersQuery(joins, filters), budget);
    const items = await details(knex, Q.orderItemsQuery(joins, filters), budget);
    const mapped = orders.map((row) => ({ ...row, status: statusLabels[row.status] || row.status, provider: labelProviders(row.providers || row.provider),
      gross_irr: tomanToIrr(row.gross_toman), shipping_irr: tomanToIrr(row.shipping_toman), discount_irr: tomanToIrr(row.discount_toman),
      total_irr: tomanToIrr(row.gross_toman) + tomanToIrr(row.shipping_toman) - tomanToIrr(row.discount_toman) }));
    return { rowCount: budget.count, notes: orderNotes, sheets: [
      sheet("خلاصه", [count("count", "تعداد سفارش"), count("units", "تعداد کالا"), money("gross_irr", "مبلغ کالاها"), money("shipping_irr", "ارسال"), money("discount_irr", "تخفیف"), money("total_irr", "مبلغ سفارش‌ها"), money("charges_irr", "پرداخت موفق"), money("refunds_irr", "بازگشت وجه"), money("net_irr", "خالص پرداخت")], [{ count: orders.length, units: orders.reduce((sum, row) => sum + Number(row.units), 0), ...Object.fromEntries(["gross_irr", "shipping_irr", "discount_irr", "total_irr", "charges_irr", "refunds_irr", "net_irr"].map((key) => [key, sumIrr(mapped, key)])) }]),
      sheet("سفارش‌ها", [col("id", "شماره سفارش"), col("external_id", "شماره سفارش قبلی"), date("date", "تاریخ سفارش"), col("status", "وضعیت"), col("customer_name", "مشتری"), col("phone", "شماره همراه"), col("provider", "درگاه‌ها"), count("units", "تعداد کالا"), money("gross_irr", "کالاها"), money("shipping_irr", "ارسال"), money("discount_irr", "تخفیف"), money("total_irr", "مبلغ سفارش"), money("charges_irr", "پرداخت موفق"), money("refunds_irr", "بازگشت وجه"), money("net_irr", "خالص پرداخت"), date("paid_at", "اولین پرداخت موفق")], mapped, true),
      sheet("اقلام سفارش", [col("order_id", "شماره سفارش"), col("id", "شناسه قلم"), col("sku", "کد محصول"), col("title", "محصول", "text", 50), col("variation_id", "شناسه تنوع"), col("color", "رنگ ثبت‌شده"), col("size", "سایز ثبت‌شده"), col("model", "مدل ثبت‌شده"), count("count", "تعداد"), money("price_irr", "قیمت واحد"), money("gross_irr", "مبلغ قلم")], items.map((row) => ({ ...row, price_irr: tomanToIrr(row.price_toman), gross_irr: tomanToIrr(row.gross_toman) })), true),
    ] };
  }
  if (report === "product-buyers") {
    const buyers = await details(knex, Q.productBuyersQuery(joins, filters), budget);
    const summary = filters.productCodes!.map((sku) => {
      const matched = buyers.filter((row) => row.sku === sku);
      return { sku, orders: new Set(matched.map((row) => row.order_id)).size, customers: new Set(matched.filter((row) => row.customer_id).map((row) => row.customer_id)).size, units: matched.reduce((sum, row) => sum + Number(row.count), 0), gross_irr: matched.reduce((sum, row) => sum + tomanToIrr(row.gross_toman), BigInt(0)) };
    });
    return { rowCount: budget.count, notes: ["بازه بر اساس تاریخ پرداخت موفق است؛ فقط سفارش‌های پرداخت‌شده در حال پردازش، ارسال‌شده یا تکمیل‌شده آمده‌اند.", "کد محصول از قلم ثبت‌شده سفارش خوانده می‌شود؛ حذف محصول یا تنوع، سابقه خرید را حذف نمی‌کند.", "مبلغ کالا قبل از تخصیص تخفیف و بازگشت وجه سفارش است."], sheets: [
      sheet("خلاصه", [count("orders", "سفارش یکتا در همه محصولات"), count("customers", "مشتری شناسایی‌شده یکتا"), count("units", "تعداد خرید"), money("gross_irr", "مبلغ کالا")], [{ orders: new Set(buyers.map((row) => row.order_id)).size, customers: new Set(buyers.filter((row) => row.customer_id).map((row) => row.customer_id)).size, units: buyers.reduce((sum, row) => sum + Number(row.count), 0), gross_irr: buyers.reduce((sum, row) => sum + tomanToIrr(row.gross_toman), BigInt(0)) }]),
      sheet("خلاصه محصولات", [col("sku", "کد محصول"), count("orders", "سفارش یکتا"), count("customers", "مشتری شناسایی‌شده یکتا"), count("units", "تعداد خرید"), money("gross_irr", "مبلغ کالا")], summary),
      sheet("خریداران", [col("sku", "کد محصول"), col("title", "محصول", "text", 50), col("variation_id", "شناسه تنوع"), col("color", "رنگ ثبت‌شده"), col("size", "سایز ثبت‌شده"), col("model", "مدل ثبت‌شده"), col("order_id", "شماره سفارش"), date("paid_at", "تاریخ پرداخت"), col("customer_name", "نام مشتری"), col("phone", "شماره همراه"), col("status", "وضعیت سفارش"), count("count", "تعداد"), money("price_irr", "قیمت واحد"), money("gross_irr", "مبلغ کالا")], buyers.map((row) => ({ ...row, status: statusLabels[row.status], price_irr: tomanToIrr(row.price_toman), gross_irr: tomanToIrr(row.gross_toman) })), true),
    ] };
  }
  return loadInventory(knex, joins, filters, budget);
}

function walletCause(value: string): string {
  return ({ "Wallet Topup": "شارژ کیف پول", "Order Payment": "پرداخت سفارش", "Admin Wallet Adjustment": "تغییر دستی", "Order Cancelled (Admin)": "بازگشت وجه سفارش لغوشده", "Order Adjustment (Admin)": "بازگشت وجه اصلاح سفارش", "SnappPay Order Refund": "بازگشت وجه سفارش اسنپ‌پی" } as Record<string, string>)[value] || value || "نامشخص";
}

async function loadInventory(knex: any, joins: PA.ResolvedJoins, filters: ExportFilters, budget: RowBudget): Promise<ReportData> {
  const matches = await rows(knex, Q.inventoryProductCandidatesQuery(joins, filters.productCode!));
  if (!matches.length) {
    const snapshots = await details(knex, Q.inventoryOrdersQuery(joins, "-1", [filters.productCode!]), budget);
    if (!snapshots.length) throw new ReportExportError("PRODUCT_NOT_FOUND", 404, "محصولی با این کد پیدا نشد");
    return { rowCount: budget.count, notes: ["فقط اقلام سفارش برای این کد باقی مانده‌اند. هویت محصول، موجودی فعلی، موجودی آغازین و تغییرات موجودی قابل تعیین نیستند.", "سفارش‌های ثبت‌شده به‌تنهایی شمارش فیزیکی انبار یا تاریخچه کامل موجودی را ثابت نمی‌کنند."], sheets: [
      sheet("خلاصه", [col("sku", "کد محصول"), col("product_id", "شناسه محصول"), count("current", "موجودی فعلی"), count("reserved", "رزروشده"), count("available", "قابل فروش"), col("reconciliation", "تطبیق", "text", 60)], [{ sku: filters.productCode, product_id: "نامشخص", current: null, reserved: null, available: null, reconciliation: "نامشخص؛ فقط اقلام سفارش باقی مانده‌اند" }]),
      inventoryOrderSheet(snapshots),
    ] };
  }
  if (matches.length !== 1) throw new ReportExportError("AMBIGUOUS_PRODUCT_CODE", 409, "این کد به بیش از یک محصول مربوط است");
  const productId = matches[0].product_id;
  const variations = await details(knex, Q.inventoryVariationsQuery(joins, productId), budget);
  const stocks = variations.map((row) => row.stock_id).filter(Boolean);
  const stockBindings = stocks.length ? stocks : ["-1"];
  const placeholders = stockBindings.map(() => "?").join(", ");
  const logs = await details(knex, { sql: `SELECT psl.id::text AS id, ll.product_stock_id::text AS stock_id,
      psl.created_at AT TIME ZONE 'UTC' AS date, psl.type, psl.count, psl.cause, psl.description
    FROM product_stock_logs psl JOIN product_stock_logs_product_stock_links ll ON ll.product_stock_log_id = psl.id
    WHERE ll.product_stock_id IN (${placeholders}) ORDER BY psl.created_at, psl.id LIMIT ${MAX_REPORT_ROWS + 1}`, bindings: stockBindings }, budget);
  const audit = await details(knex, { sql: `SELECT m.id::text AS id, COALESCE(m.occurred_at, m.created_at) AT TIME ZONE 'UTC' AS date,
      m.resource_type, m.resource_id, m.action, m.event_key, m.changes,
      COALESCE(NULLIF(m.actor_label, ''), NULLIF(m.performed_by_name, '')) AS actor,
      COALESCE(NULLIF(m.actor_role_name, ''), NULLIF(m.performed_by_role, '')) AS actor_role,
      m.metadata ->> 'reason' AS reason
    FROM manual_admin_activities m WHERE (m.resource_type = 'Stock' AND m.resource_id IN (${placeholders}))
      OR (m.resource_type = 'Product' AND m.resource_id = ?)
    ORDER BY COALESCE(m.occurred_at, m.created_at), m.id LIMIT ${MAX_REPORT_ROWS + 1}`, bindings: [...stockBindings, productId] }, budget);
  const orders = await details(knex, Q.inventoryOrdersQuery(joins, productId, [...new Set([filters.productCode!, ...variations.map((row) => normalizeOrderSku(row.sku))])]), budget);
  const summaries = inventorySummary(variations, logs, orders);
  // These summary rows represent the already-counted variation detail rows.
  return { rowCount: budget.count, notes: [
    "این گزارش موجودی فعلی و شواهد ثبت‌شده عمر محصول را نشان می‌دهد؛ شمارش فیزیکی انبار یا تاریخچه کامل نیست.",
    "تغییر موجودی در ویرایشگر محصول ممکن است بدون مقدار قبل و بعد ثبت شده باشد؛ در این حالت تطبیق قطعی و موجودی آغازین قابل تعیین نیست.",
    "برگه ثبت‌های موجودی و برگه تغییرهای کارکنان ممکن است دو شاهد یک تغییر باشند؛ مقدارشان با هم جمع نشده است.",
    "موجودی آغازین فقط در صورت وجود ثبت صریح آغاز موجودی نمایش داده شده است؛ کارمند نامشخص حدس زده نمی‌شود.",
    "سفارش مرتبط به‌تنهایی به معنی فروش یا خروج کالا نیست؛ وضعیت مصرف و نشان ثبت موجودی دستی جداگانه آمده است.",
  ], sheets: [
    sheet("خلاصه", [col("product_id", "شناسه محصول"), col("title", "محصول", "text", 50), count("variations", "تعداد تنوع"), count("current", "موجودی فعلی"), count("reserved", "رزروشده"), count("available", "قابل فروش"), col("reconciliation", "تطبیق", "text", 50)], [{ product_id: productId, title: variations[0]?.title || "", variations: variations.length, current: variations.every((row) => row.current_count !== null) ? variations.reduce((sum, row) => sum + Number(row.current_count), 0) : null, reserved: variations.every((row) => row.reserved_count !== null) ? variations.reduce((sum, row) => sum + Number(row.reserved_count), 0) : null, available: summaries.every((row) => row.available_count !== null) ? summaries.reduce((sum, row) => sum + row.available_count, 0) : null, reconciliation: "نامشخص؛ ثبت‌ها ممکن است کامل نباشند" }]),
    sheet("موجودی تنوع‌ها", [col("variation_id", "شناسه تنوع"), col("sku", "کد محصول"), col("color", "رنگ"), col("size", "سایز"), col("model", "مدل"), col("stock_id", "شناسه موجودی"), count("opening", "آغاز ثبت‌شده"), count("current_count", "موجودی فعلی"), count("reserved_count", "رزروشده"), count("available_count", "قابل فروش"), count("recorded_delta", "خالص ثبت‌های موجودی"), count("recorded_difference", "اختلاف با ثبت‌ها"), col("recorded_status", "تطبیق ثبت‌ها", "text", 42), count("consumed_units", "تعداد با مصرف ثبت‌شده"), count("manual_marked_units", "تعداد با نشان ثبت دستی"), col("reconciliation", "کامل‌بودن تاریخچه", "text", 50)], summaries, true),
    sheet("ثبت‌های موجودی", [col("id", "شناسه ثبت"), col("stock_id", "شناسه موجودی"), date("date", "تاریخ"), col("direction", "جهت"), count("count", "تعداد"), col("cause", "بابت", "text", 45), col("description", "شرح", "text", 50), col("actor", "کارمند")], logs.map((row) => ({ ...row, direction: row.type === "Add" ? "افزایش" : "کاهش", description: row.description === "Initial stock" ? "موجودی آغازین ثبت‌شده" : row.description === "Stock updated" ? "تغییر موجودی" : row.description, actor: "نامشخص" })), true),
    sheet("تغییرهای کارکنان", [col("id", "شناسه سابقه"), date("date", "تاریخ"), col("resource", "موضوع"), col("resource_id", "شناسه موضوع"), col("action", "اقدام"), count("from", "قبل"), count("to", "بعد"), count("delta", "تغییر"), col("actor", "کارمند"), col("actor_role", "نقش"), col("reason", "دلیل", "text", 55), col("evidence", "وضعیت مقدار", "text", 45)], audit.map((row) => { const change = row.resource_type === "Stock" ? stockCountChange(row.changes) : null; return { ...row, resource: row.resource_type === "Stock" ? "موجودی" : "محصول", action: ({ Create: "ایجاد", Update: "ویرایش", Adjust: "تغییر", Publish: "انتشار", Unpublish: "توقف انتشار", Delete: "حذف" } as any)[row.action] || "سایر", from: change?.from ?? null, to: change?.to ?? null, delta: change ? change.to - change.from : null, actor: row.actor || "نامشخص", actor_role: staffRoleLabel(row.actor_role), evidence: change ? "مقدار قبل و بعد ثبت شده" : "مقدار تغییر موجودی ثبت نشده" }; }), true),
    inventoryOrderSheet(orders),
  ] };
}

function inventoryOrderSheet(orders: any[]): ReportSheet {
  return sheet("سفارش‌های مرتبط", [col("order_id", "شماره سفارش"), date("date", "تاریخ سفارش"), col("variation_id", "شناسه تنوع"), col("sku", "کد محصول"), col("title", "محصول", "text", 50), count("count", "تعداد"), col("status", "وضعیت"), col("provider", "درگاه"), col("reservation_status", "وضعیت رزرو"), date("manual_stock_applied_at", "ثبت موجودی دستی")], orders.map((row) => ({ ...row, variation_id: row.variation_id || "نامشخص", provider: labelProviders(row.provider), status: statusLabels[row.status], reservation_status: ({ Reserved: "رزروشده", Released: "آزادشده", Consumed: "مصرف‌شده", Expired: "منقضی‌شده" } as any)[row.reservation_status] || "نامشخص" })), true);
}

export async function generateReportExport(strapi: any, report: ExportReport, filters: ExportFilters): Promise<{ buffer: Buffer; rowCount: number; filename: string }> {
  const generatedAt = new Date();
  // One repeatable read-only snapshot keeps separate totals/detail sheets consistent.
  const data = await strapi.db.connection.transaction(async (trx: any) => {
    await trx.raw("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    return loadReportData(trx, report, filters);
  });
  const buffer = await buildWorkbook(report, filters, data, generatedAt);
  const suffix = filters.start ? `${filters.start}_${filters.end}` : "lifetime";
  return { buffer, rowCount: data.rowCount, filename: `infinitycolor-${report}-${suffix}.xlsx` };
}

export default ({ strapi }: any) => ({ generate: (report: ExportReport, filters: ExportFilters) => generateReportExport(strapi, report, filters) });
