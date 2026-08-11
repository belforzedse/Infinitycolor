export type ManualOrderStockSuccess =
  | { success: true; applied: true; results?: unknown[] }
  | { success: true; alreadyApplied: true };

export function requireManualOrderStockSuccess(
  response: unknown,
): ManualOrderStockSuccess {
  const outer = response as any;
  const payload = outer?.data?.data ?? outer?.data ?? outer;
  const succeeded = payload?.success === true;
  const complete = payload?.applied === true || payload?.alreadyApplied === true;
  if (!succeeded || !complete || payload?.partial === true) {
    const code = String(payload?.errorCode || "MANUAL_STOCK_NOT_APPLIED");
    const message = String(payload?.error || payload?.message || code);
    throw new Error(`${code}: ${message}`);
  }
  return payload as ManualOrderStockSuccess;
}
