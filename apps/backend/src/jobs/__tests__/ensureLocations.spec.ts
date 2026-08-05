import anipoLocationCodes from "../../../database/anipo-location-codes.json";
import {
  buildAnipoLocationCodeMaps,
  normalizeIranLocationTitle,
} from "../ensureLocations";

describe("Anipo location code data", () => {
  it("contains every Iranian province and the provider code for Bukan", () => {
    const maps = buildAnipoLocationCodeMaps(anipoLocationCodes);
    const westAzerbaijan = normalizeIranLocationTitle("آذربایجان غربی");

    expect(maps.provinceCodes.size).toBe(31);
    expect(maps.provinceCodes.get(westAzerbaijan)).toBe("WAZ");
    expect(
      maps.cityCodes
        .get(westAzerbaijan)
        ?.get(normalizeIranLocationTitle("بوکان")),
    ).toBe("5951");
  });

  it("normalizes Arabic Persian variants and display punctuation", () => {
    expect(normalizeIranLocationTitle(" كـي‌ش ")).toBe(
      normalizeIranLocationTitle("کیش"),
    );
  });
});
