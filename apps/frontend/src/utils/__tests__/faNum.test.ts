import { faNum, normalizeDigits } from "../faNum";

describe("Farsi Number utilities", () => {
  describe("normalizeDigits", () => {
    it("converts Persian digits to ASCII", () => {
      expect(normalizeDigits("۱۲۳۴۵۶۷۸۹۰")).toBe("1234567890");
    });

    it("converts Arabic-Indic digits to ASCII", () => {
      expect(normalizeDigits("١٢٣٤٥٦٧٨٩٠")).toBe("1234567890");
    });

    it("preserves ASCII digits and separators", () => {
      expect(normalizeDigits("1,234")).toBe("1,234");
      expect(normalizeDigits("۱٬۲۳۴")).toBe("1٬234");
    });

    it("leaves non-digit characters untouched", () => {
      expect(normalizeDigits("abc")).toBe("abc");
      expect(normalizeDigits("")).toBe("");
    });
  });

  describe("faNum", () => {
    it("formats numbers with Farsi locale", () => {
      expect(faNum(1234)).toBe("۱٬۲۳۴");
      expect(faNum(0)).toBe("۰");
      expect(faNum(1000000)).toBe("۱٬۰۰۰٬۰۰۰");
    });

    it("handles string numbers", () => {
      expect(faNum("1234")).toBe("۱٬۲۳۴");
      expect(faNum("0")).toBe("۰");
    });

    it("handles invalid input gracefully", () => {
      expect(faNum("invalid")).toBe("invalid");
      expect(faNum("")).toBe("۰"); // Empty string gets converted to 0 in faNum
      expect(faNum(NaN)).toBe("NaN");
    });

    it("applies formatting options", () => {
      const options = { minimumFractionDigits: 2 };
      expect(faNum(1234, options)).toBe("۱٬۲۳۴٫۰۰");
    });

    it("handles negative numbers", () => {
      expect(faNum(-1234)).toBe("‎−۱٬۲۳۴");
    });

    it("handles decimal numbers", () => {
      expect(faNum(1234.56)).toBe("۱٬۲۳۴٫۵۶");
    });

    it("handles very large numbers", () => {
      expect(faNum(1000000000)).toBe("۱٬۰۰۰٬۰۰۰٬۰۰۰");
    });

    it("handles zero values", () => {
      expect(faNum(0)).toBe("۰");
      expect(faNum("0")).toBe("۰");
      expect(faNum(0.0)).toBe("۰");
    });

    it("handles string input that is not a number", () => {
      expect(faNum("abc")).toBe("abc");
      expect(faNum("123abc")).toBe("123abc");
    });

    it("preserves original input when conversion fails", () => {
      const complexInput = { invalid: "object" };
      expect(faNum(complexInput as any)).toBe("[object Object]");
    });
  });
});
