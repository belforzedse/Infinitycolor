import { analyticsEnd, MAX_REPORT_ROWS, parseExportFilters, ReportExportError, RowBudget } from "../lib/filters";

const range = { start: "2026-09-14", end: "2026-10-14" };
describe("export filters", () => {
  it("uses inclusive Tehran calendar days with an exclusive next midnight", () => {
    const input = parseExportFilters("payments", range);
    expect(input.startAt!.toISOString()).toBe("2026-09-13T20:30:00.000Z");
    expect(input.endExclusive!.toISOString()).toBe("2026-10-14T20:30:00.000Z");
    expect(analyticsEnd(input).toISOString()).toBe("2026-10-14T20:29:59.999Z");
  });
  it.each([
    {}, { ...range, start: "2026-09-13" }, { ...range, start: "2026-10-15" },
    { ...range, end: "2026-02-30" }, { ...range, end: "2026-9-14" },
    { ...range, provider: ["Wallet"] }, { ...range, provider: { $ne: "Wallet" } },
    { ...range, provider: "unknown" }, { ...range, orderStatus: "Paid" },
    { ...range, transactionType: "Pending" }, { ...range, populate: "*" },
    { ...range, end: "2026-10-14T23:59:59Z" },
  ])("rejects missing dates, invalid dates, and non-allowlisted inputs: %j", (query) => {
    try { parseExportFilters("payments", query); throw new Error("accepted invalid filters"); }
    catch (error) { expect(error).toBeInstanceOf(ReportExportError); expect((error as ReportExportError).code).toBe("INVALID_EXPORT_FILTERS"); }
  });
  it("validates leap dates", () => {
    expect(parseExportFilters("orders", { start: "2028-02-29", end: "2028-02-29" }).end).toBe("2028-02-29");
    expect(() => parseExportFilters("orders", { start: "2027-02-29", end: "2027-03-01" })).toThrow();
  });
  it("normalizes exact SKU digits without folding case and deduplicates codes", () => {
    expect(parseExportFilters("product-buyers", { ...range, productCodes: [" A-۱۲۳ ,B", "A-123"] }).productCodes).toEqual(["A-123", "B"]);
    expect(parseExportFilters("inventory-history", { productCode: " N-۰۰۱۱۹ " })).toEqual({ productCode: "N-00119" });
    expect(parseExportFilters("product-buyers", { ...range, productCodes: new Array(21).fill("A") }).productCodes).toEqual(["A"]);
  });
  it.each([undefined, "", "a,,b", { a: "b" }, Array.from({ length: 21 }, (_, i) => `p${i}`)])("rejects invalid product lists: %j", (productCodes) => {
    expect(() => parseExportFilters("product-buyers", { ...range, productCodes })).toThrow();
  });
  it("restricts inventory to a code and counts the combined detail budget", () => {
    expect(() => parseExportFilters("inventory-history", { productCode: "N", ...range })).toThrow();
    const budget = new RowBudget(); budget.consume(new Array(MAX_REPORT_ROWS - 1)); budget.consume([{}]);
    expect(budget.count).toBe(MAX_REPORT_ROWS);
    try { budget.consume([{}]); } catch (error) { expect((error as ReportExportError).status).toBe(413); }
  });
});
