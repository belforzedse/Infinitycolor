import { faNum } from "./faNum";

export const priceFormatter = (num: number, suffix?: string, prefix?: string) => {
  return (prefix ?? "") + new Intl.NumberFormat("fa-IR").format(num) + (suffix ?? "");
};

/**
 * Compact Persian label for large Toman amounts (chart axes, tight cards),
 * e.g. 4500000000 -> "۴.۵ میلیارد" or 820000 -> "۸۲۰ هزار" instead of a long
 * digit string. Falls back to the full formatted number below one thousand.
 */
export const compactToman = (value: number): string => {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  if (abs >= 1_000_000_000) {
    return `${sign}${faNum(abs / 1_000_000_000, { maximumFractionDigits: 1 })} میلیارد`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${faNum(abs / 1_000_000, { maximumFractionDigits: 1 })} میلیون`;
  }
  if (abs >= 1_000) {
    return `${sign}${faNum(abs / 1_000, { maximumFractionDigits: 1 })} هزار`;
  }
  return priceFormatter(value);
};

/**
 * Convert an IRR (rial) amount to Toman for display.
 * Some records (e.g. contract_transactions.Amount) are stored in IRR while the rest
 * of the order (contract.Amount, order_items.PerAmount) is in Toman. Use this only on
 * values known to be in rial to avoid double conversion.
 */
export const rialToToman = (irr?: number | string | null): number =>
  Math.round(Number(irr ?? 0) / 10);
