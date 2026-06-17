import {
  formatBirthDateValueForStorage,
  jalaliBirthDateToGregorianDate,
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
});
