import { integer, sumIrr } from "./money";

export const providerLabels: Record<string, string> = { all: "همه", Unknown: "نامشخص", Wallet: "کیف پول", Mellat: "ملت", SnappPay: "اسنپ‌پی", SamanKish: "سامان", ZarinPal: "زرین‌پال", Manual: "دستی", OffGateway: "خارج از درگاه", CardToCard: "کارت به کارت", Other: "سایر" };
export const statusLabels: Record<string, string> = { all: "همه", Paying: "در انتظار پرداخت", Started: "در حال پردازش", Shipment: "ارسال‌شده", Done: "تکمیل‌شده", Returned: "مرجوع‌شده", Cancelled: "لغوشده" };
export const kindLabels: Record<string, string> = { all: "همه", charge: "پرداخت سفارش", refund: "بازگشت وجه", "wallet-topup": "شارژ کیف پول", credit: "واریز", debit: "برداشت", adjustments: "تغییر دستی", "order-payments": "پرداخت سفارش" };
export const labelProviders = (value: unknown) => String(value || "Unknown").split("، ").map((item) => providerLabels[item] || item).join("، ");
export const isManualAdjustment = (row: any): boolean => Boolean(row.adjustment_id || row.cause === "Admin Wallet Adjustment" || /^admin-adj-\d+-.+/.test(row.reference || ""));
export function staffRoleLabel(role: unknown): string {
  const labels: Record<string, string> = { superadmin: "مدیر کل", founder: "بنیان‌گذار", finance: "مالی", "store manager": "مدیر فروشگاه", "store-manager": "مدیر فروشگاه", "seller 1": "فروشنده ۱", "seller-1": "فروشنده ۱", "seller 2": "فروشنده ۲", "seller-2": "فروشنده ۲", editor: "ویراستار" };
  return role ? labels[String(role).toLowerCase()] || String(role) : "نامشخص";
}
export function splitPaymentControl(row: any): Record<string, any> {
  const invoice = integer(row.gross_toman) * BigInt(10) + integer(row.shipping_toman) * BigInt(10) - integer(row.discount_toman) * BigInt(10);
  const charged = integer(row.charges_irr), wallet = integer(row.wallet_charges_irr), net = integer(row.net_irr);
  const share = charged > BigInt(0) ? wallet * BigInt(1000) / charged : BigInt(0);
  const delta = net - invoice;
  return { ...row, invoice_irr: invoice, control_irr: delta, wallet_share: `${share / BigInt(10)}.${share % BigInt(10)}٪`,
    control: delta === BigInt(0) ? "برابر" : "اختلاف دارد" };
}

/** Wallet credits are liabilities, not evidence that cash left a bank account. */
export function paymentSummary(rows: any[]): Record<string, any>[] {
  const grouped = new Map<string, any>();
  for (const row of rows) {
    const key = `${row.provider}:${row.kind}:${row.evidence}`;
    const entry = grouped.get(key) || { provider: row.provider, kind: row.kind, evidence: row.evidence, count: 0, amount_irr: BigInt(0), cash_irr: BigInt(0) };
    const amount = integer(row.amount_irr);
    entry.count += 1; entry.amount_irr += amount;
    if (String(row.evidence).includes("تاریخ ثبت درخواست")) entry.cash_irr = null;
    else if (entry.cash_irr !== null && row.provider !== "Wallet" && row.provider !== "Unknown" && row.provider !== "OffGateway") entry.cash_irr += row.kind === "refund" ? -amount : amount;
    grouped.set(key, entry);
  }
  return [...grouped.values()].map((row) => ({ ...row, provider: labelProviders(row.provider), kind: kindLabels[row.kind] || row.kind }));
}
export function walletSummary(rows: any[]): Record<string, any>[] {
  const credits = sumIrr(rows.filter((row) => row.type === "Add"), "amount_irr");
  const debits = sumIrr(rows.filter((row) => row.type === "Minus"), "amount_irr");
  return [{ count: rows.length, credits_irr: credits, debits_irr: debits, net_irr: credits - debits,
    adjustment_credits_irr: sumIrr(rows.filter((row) => isManualAdjustment(row) && row.type === "Add"), "amount_irr"),
    adjustment_debits_irr: sumIrr(rows.filter((row) => isManualAdjustment(row) && row.type === "Minus"), "amount_irr") }];
}

export function stockCountChange(changes: unknown): { from: number; to: number } | null {
  let input = changes;
  if (typeof input === "string") { try { input = JSON.parse(input); } catch { return null; } }
  const raw: any = Array.isArray(input)
    ? input.find((item) => ["Count", "count"].includes(item?.field))
    : input && typeof input === "object" ? (input as any).Count || (input as any).count : null;
  if (!raw || raw.from === null || raw.to === null || raw.from === "" || raw.to === "") return null;
  const from = Number(raw.from), to = Number(raw.to);
  return Number.isSafeInteger(from) && from >= 0 && Number.isSafeInteger(to) && to >= 0 ? { from, to } : null;
}

/** Audit and log representations are parallel evidence, never added together. */
export function inventorySummary(variations: any[], logs: any[], orders: any[]): Record<string, any>[] {
  return variations.map((variation) => {
    const stockLogs = logs.filter((log) => String(log.stock_id) === String(variation.stock_id));
    const opening = stockLogs.find((log) => log.description === "Initial stock" && log.type === "Add");
    const recordedDelta = stockLogs.reduce((sum, log) => sum + (log.type === "Add" ? Number(log.count) : -Number(log.count)), 0);
    const related = orders.filter((order) => order.variation_id != null && String(order.variation_id) === String(variation.variation_id));
    const difference = !opening || variation.current_count === null ? null : Number(variation.current_count) - recordedDelta;
    return { ...variation, opening: opening ? Number(opening.count) : null,
      recorded_delta: recordedDelta,
      recorded_difference: difference,
      recorded_status: difference === null ? "مبنای آغاز ثبت نشده" : difference === 0 ? "ثبت‌ها با موجودی فعلی برابرند" : "اختلاف با ثبت‌های موجودی",
      consumed_units: related.filter((row) => row.reservation_status === "Consumed").reduce((sum, row) => sum + Number(row.count), 0),
      manual_marked_units: related.filter((row) => row.manual_stock_applied_at).reduce((sum, row) => sum + Number(row.count), 0),
      available_count: variation.current_count === null ? null : Number(variation.current_count) - Number(variation.reserved_count || 0),
      reconciliation: "نامشخص؛ ثبت‌ها ممکن است کامل نباشند" };
  });
}
