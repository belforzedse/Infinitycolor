import { faNum, formatFaDate, normalizeDigits } from "../faNum";

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

    it("emits Persian digits even when the ICU default would use latn", () => {
      const original = Number.prototype.toLocaleString;
      Number.prototype.toLocaleString = function toLocaleString() {
        return "1,234";
      };
      try {
        expect(faNum(1234)).toBe("۱,۲۳۴");
      } finally {
        Number.prototype.toLocaleString = original;
      }
    });
  });

  describe("formatFaDate", () => {
    it("formats the same ISO instant identically under UTC and Tehran process TZ", () => {
      const iso = "2026-03-20T21:30:00.000Z";
      const previousTz = process.env.TZ;
      try {
        process.env.TZ = "UTC";
        const utcHost = formatFaDate(iso);
        process.env.TZ = "Asia/Tehran";
        const tehranHost = formatFaDate(iso);
        expect(utcHost).toBe(tehranHost);
        expect(utcHost.length).toBeGreaterThan(0);
        expect(utcHost).not.toMatch(/[0-9]/);
      } finally {
        if (previousTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTz;
        }
      }
    });

    it("returns empty string for missing or invalid input", () => {
      expect(formatFaDate(null)).toBe("");
      expect(formatFaDate(undefined)).toBe("");
      expect(formatFaDate("not-a-date")).toBe("");
    });

    it("accepts long-form date options without dropping the Tehran zone", () => {
      const formatted = formatFaDate("2026-03-20T21:30:00.000Z", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).not.toMatch(/[0-9]/);
    });

    it("SSR and client hosts emit the same price and date strings", () => {
      const iso = "2026-03-20T21:30:00.000Z";
      const previousTz = process.env.TZ;
      try {
        process.env.TZ = "UTC";
        const ssr = `${faNum(1234)}|${formatFaDate(iso)}`;
        process.env.TZ = "America/New_York";
        const client = `${faNum(1234)}|${formatFaDate(iso)}`;
        expect(client).toBe(ssr);
        expect(ssr).toBe("۱٬۲۳۴|" + formatFaDate(iso));
      } finally {
        if (previousTz === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previousTz;
        }
      }
    });
  });
});
