export const priceFormatter = (num: number, suffix?: string, prefix?: string) => {
  return (prefix ?? "") + new Intl.NumberFormat("fa-IR").format(num) + (suffix ?? "");
};

/**
 * Convert an IRR (rial) amount to Toman for display.
 * Some records (e.g. contract_transactions.Amount) are stored in IRR while the rest
 * of the order (contract.Amount, order_items.PerAmount) is in Toman. Use this only on
 * values known to be in rial to avoid double conversion.
 */
export const rialToToman = (irr?: number | string | null): number =>
  Math.round(Number(irr ?? 0) / 10);
