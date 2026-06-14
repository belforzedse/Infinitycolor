/**
 * Shared, beautifully-formatted Excel (.xlsx) exporter for the super-admin
 * reports. Replaces the old plain-CSV downloads.
 *
 * Styling (every sheet): RTL layout, frozen + green styled header bar, thin
 * borders, zebra striping, auto-fit columns and number formatting. Built with
 * ExcelJS (dynamically imported so it stays out of the main bundle).
 */

export type ExcelColumn = {
  /** Visible header label (Persian). */
  header: string;
  /** Key used to look up the value in each row object. */
  key: string;
  /** Optional fixed column width (in characters). Auto-fit when omitted. */
  width?: number;
  /** Optional Excel number format, e.g. "#,##0". Forces right alignment. */
  numFmt?: string;
};

export type ExcelSheet = {
  /** Worksheet (tab) name. */
  name: string;
  columns: ExcelColumn[];
  rows: Array<Record<string, unknown>>;
};

// Excel-green theme (tailwind green-600) to match the existing export button.
const HEADER_FILL = "FF16A34A";
const HEADER_FONT = "FFFFFFFF";
const BORDER_COLOR = "FFE5E7EB"; // neutral-200
const ZEBRA_FILL = "FFF9FAFB"; // neutral-50
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const thinBorder = (color: string) =>
  ({ style: "thin", color: { argb: color } }) as const;

/** Estimate a column width from its header + a sample of its cell values. */
function autoWidth(col: ExcelColumn, rows: Array<Record<string, unknown>>): number {
  if (col.width) return col.width;
  let max = col.header.length;
  for (const row of rows) {
    const v = row[col.key];
    if (v == null) continue;
    const len = String(v).length;
    if (len > max) max = len;
  }
  // A little breathing room; clamp to a sensible range.
  return Math.min(Math.max(max + 4, 10), 60);
}

/**
 * Build and download a styled .xlsx file. Each sheet gets the green header,
 * RTL view, frozen header row, borders, zebra striping and number formats.
 */
export async function exportExcel(opts: {
  /** File name without extension. */
  filename: string;
  sheets: ExcelSheet[];
}): Promise<void> {
  if (typeof window === "undefined") return;

  const ExcelJSModule = await import("exceljs");
  const ExcelJS = ExcelJSModule.default ?? ExcelJSModule;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Infinity";
  workbook.created = new Date();

  for (const sheet of opts.sheets) {
    const ws = workbook.addWorksheet(sheet.name, {
      views: [{ rightToLeft: true, state: "frozen", ySplit: 1 }],
    });

    ws.columns = sheet.columns.map((c) => ({
      key: c.key,
      width: autoWidth(c, sheet.rows),
      style: c.numFmt
        ? { numFmt: c.numFmt, alignment: { horizontal: "right" } }
        : undefined,
    }));

    // Header row.
    const headerRow = ws.addRow(
      sheet.columns.reduce<Record<string, string>>((acc, c) => {
        acc[c.key] = c.header;
        return acc;
      }, {}),
    );
    headerRow.height = 22;
    headerRow.eachCell((cell) => {
      cell.font = { bold: true, size: 12, color: { argb: HEADER_FONT } };
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: HEADER_FILL },
      };
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = {
        top: thinBorder(HEADER_FILL),
        bottom: thinBorder(HEADER_FILL),
        left: thinBorder("FFFFFFFF"),
        right: thinBorder("FFFFFFFF"),
      };
    });

    // Body rows.
    sheet.rows.forEach((row, i) => {
      const added = ws.addRow(row);
      const zebra = i % 2 === 1;
      added.eachCell({ includeEmpty: true }, (cell) => {
        cell.alignment = { vertical: "middle", ...(cell.alignment ?? {}) };
        cell.border = {
          top: thinBorder(BORDER_COLOR),
          bottom: thinBorder(BORDER_COLOR),
          left: thinBorder(BORDER_COLOR),
          right: thinBorder(BORDER_COLOR),
        };
        if (zebra) {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: ZEBRA_FILL },
          };
        }
      });
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], { type: XLSX_MIME });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = `${opts.filename}.xlsx`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}
