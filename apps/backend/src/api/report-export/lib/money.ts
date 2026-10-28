/** Amounts are integer IRR throughout calculation; no floating-point aggregation. */
export function integer(value: unknown): bigint {
  if (value === null || value === undefined || value === "") return BigInt(0);
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("UNSAFE_REPORT_AMOUNT");
  const text = String(value);
  if (!/^-?\d+$/.test(text)) throw new Error("INVALID_REPORT_AMOUNT");
  return BigInt(text);
}
export const tomanToIrr = (value: unknown): bigint => integer(value) * BigInt(10);
export const sumIrr = (rows: any[], key: string): bigint => rows.reduce((sum, row) => sum + integer(row[key]), BigInt(0));
export function tomanText(value: unknown): string {
  const irr = integer(value), abs = irr < BigInt(0) ? -irr : irr;
  return `${irr < BigInt(0) ? "-" : ""}${abs / BigInt(10)}.${abs % BigInt(10)}`;
}
/** Keep Excel's 15 significant digit ceiling from rounding financial facts. */
export function excelMoney(value: unknown): string | number {
  const irr = integer(value);
  return (irr < BigInt(0) ? -irr : irr) <= BigInt("999999999999999") ? Number(irr) / 10 : tomanText(irr);
}
