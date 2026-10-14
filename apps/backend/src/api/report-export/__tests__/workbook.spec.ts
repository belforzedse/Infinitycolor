import ExcelJS from "exceljs";
import { buildWorkbook, tehranTimestamp } from "../lib/workbook";
import { parseExportFilters } from "../lib/filters";

describe("streaming XLSX workbook", () => {
  it("finalizes a readable Persian RTL workbook with frozen/filterable fixed-width headers and text identifiers", async () => {
    const buffer = await buildWorkbook("payments", parseExportFilters("payments", { start: "2026-09-14", end: "2026-09-14", provider: "Wallet" }), {
      rowCount: 1, sheets: [{ name: "گردش", columns: [{ key: "ref", label: "مرجع", width: 35 }, { key: "phone", label: "شماره همراه" }, { key: "amount", label: "تومان", type: "money" }, { key: "large", label: "مبلغ بزرگ", type: "money" }], rows: [{ ref: '=HYPERLINK("https://example.invalid")', phone: "09120000000", amount: "1001", large: "9007199254740993" }], detail: true }],
    }, new Date("2026-09-14T00:00:00Z"));
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any);
    const ws = book.getWorksheet("گردش")!;
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1, rightToLeft: true });
    expect(ws.autoFilter).toBe("A1:D2"); expect(ws.getColumn(1).width).toBe(35);
    expect(ws.getCell("A2").type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell("A2").value).toBe('=HYPERLINK("https://example.invalid")');
    expect(ws.getCell("B2").value).toBe("09120000000"); expect(ws.getCell("B2").numFmt).toBe("@");
    expect(ws.getCell("C2").value).toBe(100.1); expect(ws.getCell("D2").value).toBe("900719925474099.3");
    const metadata = book.getWorksheet("مشخصات گزارش")!;
    const allValues: any[] = []; metadata.eachRow((row) => allValues.push(...(row.values as any[])));
    expect(allValues).toContain("کیف پول"); expect(allValues).toContain("۱۴۰۵/۰۶/۲۳");
  });
  it("keeps empty report headers and zero summary totals", async () => {
    const buffer = await buildWorkbook("wallet", {}, { rowCount: 0, sheets: [{ name: "خلاصه", columns: [{ key: "total", label: "جمع", type: "money" }], rows: [{ total: BigInt(0) }] }, { name: "گردش", columns: [{ key: "id", label: "شناسه" }], rows: [] }] });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any);
    expect(book.getWorksheet("خلاصه")!.getCell("A2").value).toBe(0);
    expect(book.getWorksheet("گردش")!.rowCount).toBe(1);
  });
  it("uses Jalali dates at the Tehran midnight boundary", () => {
    expect(tehranTimestamp("2026-09-13T20:30:00Z")).toBe("۱۴۰۵/۰۶/۲۳ ۰۰:۰۰:۰۰");
  });
  it("fits wrapped explanations and explicitly marks missing inventory balances", async () => {
    const note = "موجودی آغازین از سوابق ثبت‌شده قابل تعیین نیست. ".repeat(5);
    const buffer = await buildWorkbook("inventory-history", {}, {
      rowCount: 1, notes: [note], sheets: [{ name: "موجودی", columns: [{ key: "balance", label: "موجودی فعلی", type: "number" }], rows: [{ balance: null }] }],
    });
    const book = new ExcelJS.Workbook(); await book.xlsx.load(buffer as any);
    const metadata = book.getWorksheet("مشخصات گزارش")!;
    expect(metadata.getRow(7).height).toBeGreaterThan(22);
    expect(metadata.getCell("B7").value).toBe(note);
    expect(book.getWorksheet("موجودی")!.getCell("A2").value).toBe("نامشخص");
  });
});
