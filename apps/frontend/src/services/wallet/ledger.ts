export type WalletLedgerType = "Add" | "Minus";

export type WalletLedgerEntry = {
  id: number;
  amountIrr: number;
  type: WalletLedgerType;
  date: string;
  cause?: string;
  referenceId?: string;
  note?: string;
};

export type WalletLedgerUiRow = {
  date: string;
  amountToman: number;
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const readField = (record: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
};

const optionalString = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
};

const toIsoDate = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  return "";
};

/**
 * Content-API `find` wraps Type/Amount/Date in `attributes`. The owner ledger
 * endpoint returns the same fields at the top level. Either shape has to become
 * a typed row, or the wallet page treats Type as missing and shows an empty list.
 */
export const toWalletLedgerEntry = (row: unknown): WalletLedgerEntry | null => {
  const record = asRecord(row);
  if (!record) return null;
  const attrs = asRecord(record.attributes) ?? record;
  const typeRaw = String(readField(attrs, "Type", "type") ?? "");
  if (typeRaw !== "Add" && typeRaw !== "Minus") return null;
  const amountIrr = Number(readField(attrs, "Amount", "amount"));
  if (!Number.isFinite(amountIrr)) return null;
  const id = Number(record.id ?? attrs.id ?? 0);
  return {
    id: Number.isFinite(id) ? id : 0,
    amountIrr,
    type: typeRaw,
    date: toIsoDate(readField(attrs, "Date", "date", "createdAt")),
    cause: optionalString(readField(attrs, "Cause", "cause")),
    referenceId: optionalString(
      readField(attrs, "ReferenceId", "referenceId", "reference_id"),
    ),
    note: optionalString(readField(attrs, "Note", "note")),
  };
};

export const toWalletLedgerEntries = (rows: unknown): WalletLedgerEntry[] => {
  if (!Array.isArray(rows)) return [];
  const entries: WalletLedgerEntry[] = [];
  for (const row of rows) {
    const entry = toWalletLedgerEntry(row);
    if (entry) entries.push(entry);
  }
  return entries;
};

export const splitWalletLedger = (entries: WalletLedgerEntry[]) => {
  const deposits: WalletLedgerUiRow[] = [];
  const purchases: WalletLedgerUiRow[] = [];
  for (const entry of entries) {
    const parsed = entry.date ? new Date(entry.date) : null;
    const date =
      parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString().split("T")[0] : "";
    const row: WalletLedgerUiRow = {
      date,
      amountToman: Math.round(entry.amountIrr / 10),
    };
    if (entry.type === "Add") deposits.push(row);
    else purchases.push(row);
  }
  return { deposits, purchases };
};
