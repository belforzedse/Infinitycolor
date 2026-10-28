import ExcelJS from "exceljs";
import { Writable } from "node:stream";
import { excelMoney } from "./money";
import { ExportFilters, ExportReport } from "./filters";
import { kindLabels, providerLabels, statusLabels } from "./semantics";

export type ReportColumn = { key: string; label: string; width?: number; type?: "text" | "number" | "money" | "date" };
export type ReportSheet = { name: string; columns: ReportColumn[]; rows: Record<string, any>[]; detail?: boolean };
export type ReportData = { sheets: ReportSheet[]; notes?: string[]; rowCount: number };
const titles: Record<ExportReport, string> = { payments: "پرداخت‌ها", wallet: "گردش کیف پول", orders: "سفارش‌ها", "product-buyers": "خریداران محصول", "inventory-history": "تاریخچه موجودی" };
const filterNames: Record<string, string> = { start: "از تاریخ", end: "تا تاریخ", provider: "درگاه", orderStatus: "وضعیت سفارش", transactionType: "نوع تراکنش", direction: "جهت گردش", kind: "نوع گردش", productCode: "کد محصول", productCodes: "کدهای محصول" };
export function tehranTimestamp(value: unknown): string {
  if (!value) return "";
  const time = new Date(value as any).getTime();
  if (!Number.isFinite(time)) return "";
  const parts = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(new Date(time));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return `${part("year")}/${part("month")}/${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}
function filterValue(key: string, value: unknown): string {
  if (key === "start" || key === "end") return tehranTimestamp(`${value}T12:00:00+03:30`).split(" ")[0];
  if (key === "provider") return providerLabels[String(value)] || String(value);
  if (key === "orderStatus") return statusLabels[String(value)] || String(value);
  if (["transactionType", "direction", "kind"].includes(key)) return kindLabels[String(value)] || String(value);
  return Array.isArray(value) ? value.join("، ") : String(value);
}
function fittedHeight(values: unknown[], columns: ReportColumn[], minimum: number): number {
  const lines = values.reduce<number>((max, value, index) => {
    const width = Math.max(1, Math.floor((columns[index].width || (columns[index].type === "money" ? 22 : 26)) * 0.85));
    const wrapped = String(value ?? "").split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / width)), 0);
    return Math.max(max, wrapped);
  }, 1);
  return Math.min(409, Math.max(minimum, lines * 15 + 6));
}
export async function buildWorkbook(report: ExportReport, filters: ExportFilters, data: ReportData, generatedAt = new Date()): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const output = new Writable({ write(chunk, _encoding, next) { chunks.push(Buffer.from(chunk)); next(); } });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useStyles: true, useSharedStrings: false });
  workbook.creator = "Infinitycolor";
  workbook.created = generatedAt;
  const metadata: ReportSheet = {
    name: "مشخصات گزارش", columns: [{ key: "label", label: "عنوان", width: 30 }, { key: "value", label: "مقدار", width: 95 }],
    rows: [
      { label: "گزارش", value: titles[report] }, { label: "زمان تهیه (تهران)", value: tehranTimestamp(generatedAt) },
      { label: "واحد مبلغ", value: "تومان؛ یک رقم اعشار برابر یک ریال" },
      { label: "تاریخ‌ها", value: "هجری شمسی، به وقت تهران؛ ابتدا و انتهای بازه شامل روز انتخاب‌شده‌اند" },
      { label: "ردیف‌های جزئیات", value: String(data.rowCount) },
      ...Object.entries(filters).filter(([key]) => filterNames[key]).map(([key, value]) => ({ label: filterNames[key], value: filterValue(key, value) })),
      ...(data.notes || []).map((value) => ({ label: "توضیح", value })),
    ],
  };
  for (const spec of [metadata, ...data.sheets]) {
    const sheet = workbook.addWorksheet(spec.name, { views: [{ state: "frozen", ySplit: 1, rightToLeft: true }] });
    sheet.columns = spec.columns.map((column) => ({ key: column.key, width: column.width || (column.type === "money" ? 22 : 26) }));
    const header = sheet.addRow(spec.columns.map((column) => column.label));
    header.height = fittedHeight(spec.columns.map((column) => column.label), spec.columns, 28);
    header.eachCell((cell) => {
      cell.font = { name: "Tahoma", bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } };
      cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
    });
    header.commit();
    for (const raw of spec.rows) {
      const values = spec.columns.map((column) => {
        const value = raw[column.key];
        if (value === null || value === undefined) return column.type === "number" ? "نامشخص" : "";
        if (column.type === "money") return excelMoney(value);
        if (column.type === "number") return Number(value);
        if (column.type === "date") return tehranTimestamp(value);
        // Plain strings, never formula/hyperlink/rich-text objects from data sources.
        return String(value).slice(0, 32767);
      });
      const row = sheet.addRow(values);
      row.height = fittedHeight(values, spec.columns, 22);
      row.eachCell({ includeEmpty: true }, (cell, index) => {
        const type = spec.columns[index - 1].type;
        cell.font = { name: "Tahoma", size: 10 };
        cell.alignment = { horizontal: "right", vertical: "middle", wrapText: true };
        cell.numFmt = type === "money" && typeof cell.value === "number" ? "#,##0.0;[Red]-#,##0.0" : type === "number" ? "0" : "@";
      });
      row.commit();
    }
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, spec.rows.length + 1), column: spec.columns.length } };
    sheet.commit();
  }
  await workbook.commit();
  return Buffer.concat(chunks);
}
