/**
 * Shared, beautifully-formatted Excel (.xlsx) builder for server-side report
 * exports (replaces the old plain-CSV responses).
 *
 * Produces an RTL workbook with a green styled header bar, borders, zebra
 * striping, auto-fit columns and number formatting — matching the frontend
 * `exportExcel` helper. Returns a Buffer ready to send as the response body.
 */

import ExcelJS from "exceljs";

export type WorkbookColumn = {
  /** Visible header label (Persian). */
  header: string;
  /** Numeric column → right-aligned with a thousands separator. */
  numeric?: boolean;
  /** Optional fixed width (characters). Auto-fit when omitted. */
  width?: number;
  /** Override the Excel number format (defaults to "#,##0" when numeric). */
  numFmt?: string;
};

// Excel-green theme (tailwind green-600) to match the frontend export button.
const HEADER_FILL = "FF16A34A";
const HEADER_FONT = "FFFFFFFF";
const BORDER_COLOR = "FFE5E7EB"; // neutral-200
const ZEBRA_FILL = "FFF9FAFB"; // neutral-50

const thin = (argb: string) => ({ style: "thin" as const, color: { argb } });

function autoWidth(
  col: WorkbookColumn,
  index: number,
  rows: Array<Array<string | number | null>>,
): number {
  if (col.width) return col.width;
  let max = col.header.length;
  for (const row of rows) {
    const v = row[index];
    if (v == null) continue;
    const len = String(v).length;
    if (len > max) max = len;
  }
  return Math.min(Math.max(max + 4, 10), 60);
}

/** Sheet names can't exceed 31 chars or contain []*?/\: */
function safeSheetName(name: string): string {
  return name.replace(/[[\]*?/\\:]/g, " ").trim().slice(0, 31) || "گزارش";
}

export async function buildStyledWorkbook(opts: {
  sheetName: string;
  columns: WorkbookColumn[];
  rows: Array<Array<string | number | null>>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Infinity";
  workbook.created = new Date();

  const ws = workbook.addWorksheet(safeSheetName(opts.sheetName), {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
  });

  ws.columns = opts.columns.map((c, i) => ({
    key: `c${i}`,
    width: autoWidth(c, i, opts.rows),
    style: c.numeric
      ? { numFmt: c.numFmt ?? "#,##0", alignment: { horizontal: "right" } }
      : undefined,
  }));

  // Header row.
  const headerRow = ws.addRow(opts.columns.map((c) => c.header));
  headerRow.height = 22;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 12, color: { argb: HEADER_FONT } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: HEADER_FILL } };
    cell.alignment = { horizontal: "center", vertical: "middle" };
    cell.border = {
      top: thin(HEADER_FILL),
      bottom: thin(HEADER_FILL),
      left: thin("FFFFFFFF"),
      right: thin("FFFFFFFF"),
    };
  });

  // Body rows.
  opts.rows.forEach((row, i) => {
    const added = ws.addRow(row);
    const zebra = i % 2 === 1;
    added.eachCell({ includeEmpty: true }, (cell) => {
      cell.alignment = { vertical: "middle", ...(cell.alignment ?? {}) };
      cell.border = {
        top: thin(BORDER_COLOR),
        bottom: thin(BORDER_COLOR),
        left: thin(BORDER_COLOR),
        right: thin(BORDER_COLOR),
      };
      if (zebra) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: ZEBRA_FILL } };
      }
    });
  });

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
