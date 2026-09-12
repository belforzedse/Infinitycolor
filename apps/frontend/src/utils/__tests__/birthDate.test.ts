import {
  formatBirthDateValueForStorage,
  isJalaliLeapYear,
  jalaliBirthDateToGregorianDate,
  jalaliMonthLength,
  normalizeDigits,
  parseStoredBirthDateToJalaliParts,
} from "../birthDate";

describe("birthDate utils", () => {
  it("converts stored Gregorian dates to Jalali display parts", () => {
    expect(parseStoredBirthDateToJalaliParts("1990-03-21")).toEqual({
      birthYear: "1369",
      birthMonth: "01",
      birthDay: "01",
    });
  });

  it("keeps legacy Jalali-looking stored dates readable", () => {
    expect(parseStoredBirthDateToJalaliParts("1370-07-05")).toEqual({
      birthYear: "1370",
      birthMonth: "07",
      birthDay: "05",
    });
  });

  it("normalizes Jalali input to Gregorian storage", () => {
    expect(jalaliBirthDateToGregorianDate("1369", "1", "1")).toBe("1990-03-21");
  });

  it("formats Date objects as Gregorian storage values", () => {
    expect(formatBirthDateValueForStorage(new Date(1990, 2, 21))).toBe("1990-03-21");
  });

  it("rejects a day the Jalali month does not have", () => {
    // Mehr-Bahman are 30-day months, so there is no 31st. The old literal `day > 31`
    // bound let this through and the caller silently kept the previous birth date.
    expect(jalaliBirthDateToGregorianDate("1388", "8", "31")).toBeNull();
    expect(jalaliBirthDateToGregorianDate("1388", "7", "31")).toBeNull();
  });

  it("rejects Esfand 30 in a common year but accepts it in a leap year", () => {
    expect(isJalaliLeapYear("1388")).toBe(false);
    expect(jalaliBirthDateToGregorianDate("1388", "12", "30")).toBeNull();

    expect(isJalaliLeapYear("1387")).toBe(true);
    expect(jalaliBirthDateToGregorianDate("1387", "12", "30")).toBe("2009-03-20");
  });

  it("reports Jalali month lengths", () => {
    expect(jalaliMonthLength("1388", "1")).toBe(31);
    expect(jalaliMonthLength("1388", "6")).toBe(31);
    expect(jalaliMonthLength("1388", "7")).toBe(30);
    expect(jalaliMonthLength("1388", "11")).toBe(30);
    expect(jalaliMonthLength("1388", "12")).toBe(29);
    expect(jalaliMonthLength("1387", "12")).toBe(30);
    expect(jalaliMonthLength("1388", "13")).toBe(0);
  });

  it("accepts Persian and Arabic digits and leading zeros", () => {
    expect(normalizeDigits("۱۳۷۰")).toBe("1370");
    expect(normalizeDigits("١٣٧٠")).toBe("1370");
    expect(jalaliBirthDateToGregorianDate("۱۳۷۰", "۰۱", "۰۸")).toBe("1991-03-28");
    expect(jalaliBirthDateToGregorianDate("1370", "01", "08")).toBe("1991-03-28");
  });

  it("round-trips a padded stored value back to padded display parts", () => {
    const stored = jalaliBirthDateToGregorianDate("1370", "1", "8");
    expect(stored).toBe("1991-03-28");
    expect(parseStoredBirthDateToJalaliParts(stored)).toEqual({
      birthYear: "1370",
      birthMonth: "01",
      birthDay: "08",
    });
  });

  it("rejects a Gregorian day the month does not have instead of rolling it forward", () => {
    // `Date.UTC(2025, 1, 31)` silently becomes 2025-03-03; the round-trip check rejects it.
    expect(parseStoredBirthDateToJalaliParts("2025-02-31")).toEqual({
      birthYear: "",
      birthMonth: "",
      birthDay: "",
    });
    expect(formatBirthDateValueForStorage("2025-02-31")).toBeUndefined();
  });
});
