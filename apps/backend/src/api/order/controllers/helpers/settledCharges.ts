/**
 * What the customer was charged for an order, in IRR, from its settled legs.
 *
 * A leg counts when its contract transaction is `Success` and is not a
 * `Return`: one row for a single gateway or a wallet-only order, two for a
 * wallet + gateway split. `contract_transactions.Amount` is IRR and already net
 * of discount (see `paidAmount.ts`). Refunds are reported separately, so this
 * is the charge at settlement time, not the current net balance.
 *
 * Shared by the payment-status response (the storefront's revenue-bearing
 * `purchase` analytics event) and the analytics outbox (`order_paid`).
 */
export type SettledCharges = {
  amountIrr: number;
  /** Latest settlement moment across the legs, ISO-8601, or null if unknown. */
  settledAt: string | null;
  legCount: number;
};

function legTimestamp(tx: any): number | null {
  const raw = tx?.SettledAt ?? tx?.VerifiedAt ?? tx?.Date ?? tx?.createdAt;
  if (!raw) return null;
  const time = new Date(raw).getTime();
  return Number.isFinite(time) ? time : null;
}

export function summarizeSettledCharges(transactions: unknown): SettledCharges {
  const list = Array.isArray(transactions) ? transactions : [];
  let amountIrr = 0;
  let latest: number | null = null;
  let legCount = 0;
  for (const tx of list as any[]) {
    if (String(tx?.Status ?? tx?.status ?? "").toLowerCase() !== "success") continue;
    if (String(tx?.Type ?? tx?.type ?? "").toLowerCase() === "return") continue;
    const amount = Math.round(Number(tx?.Amount ?? tx?.amount ?? 0));
    if (!Number.isFinite(amount) || amount <= 0) continue;
    amountIrr += amount;
    legCount += 1;
    const time = legTimestamp(tx);
    if (time !== null && (latest === null || time > latest)) latest = time;
  }
  return {
    amountIrr,
    settledAt: latest === null ? null : new Date(latest).toISOString(),
    legCount,
  };
}
