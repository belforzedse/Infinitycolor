import {
  buildColorFamilyBuckets,
  buildFourShades,
  colorFamilyKeysFromTitle,
  conicGradientFromShades,
  expandColorKeysToTitles,
} from "../plpColorFilter";

describe("colorFamilyKeysFromTitle", () => {
  it("maps blue aliases onto blue and keeps navy separate", () => {
    expect(colorFamilyKeysFromTitle("آبی تیره")).toEqual(["blue"]);
    expect(colorFamilyKeysFromTitle("E2E Blue")).toEqual(["blue"]);
    expect(colorFamilyKeysFromTitle("سرمه ای گلدار")).toEqual(["navy"]);
  });

  it("allows dual membership for compound titles", () => {
    expect(colorFamilyKeysFromTitle("سفید آبی").sort()).toEqual(["blue", "white"]);
  });
});

describe("expandColorKeysToTitles", () => {
  it("expands the blue family across catalog titles", () => {
    const titles = expandColorKeysToTitles(
      ["blue"],
      [
        { title: "E2E Blue", colorCode: "#0057ff" },
        { title: "آبی تیره", colorCode: "#4C5E74" },
        { title: "سرمه ای گلدار", colorCode: null },
        { title: "E2E Unavailable Black", colorCode: "#111111" },
      ],
    );
    expect(titles).toEqual(expect.arrayContaining(["E2E Blue", "آبی تیره"]));
    expect(titles).not.toEqual(expect.arrayContaining(["سرمه ای گلدار", "E2E Unavailable Black"]));
  });
});

describe("buildColorFamilyBuckets", () => {
  it("builds a 4-shade palette and parks unmatched titles in سایر", () => {
    const buckets = buildColorFamilyBuckets([
      { title: "آبی", colorCode: "#2196F3" },
      { title: "آبی روشن", colorCode: "#40AAFF" },
      { title: "آبی یخی", colorCode: "#D5F2FF" },
      { title: "آبی نفتی", colorCode: "#10265B" },
      { title: "تدی", colorCode: null },
    ]);

    const blue = buckets.find((bucket) => bucket.key === "blue");
    expect(blue?.titles).toEqual(expect.arrayContaining(["آبی", "آبی روشن"]));
    expect(blue?.shades).toHaveLength(4);
    expect(blue?.shades.every((shade) => shade.startsWith("#"))).toBe(true);

    const other = buckets.find((bucket) => bucket.key === "other");
    expect(other?.label).toBe("سایر");
    expect(other?.titles).toEqual(["تدی"]);
  });
});

describe("buildFourShades", () => {
  it("always returns four revolving stops from light to dark", () => {
    const shades = buildFourShades(["#00E676"], ["#E4F5DC", "#A8D98A", "#4C9A3A", "#1B4332"]);
    expect(shades).toHaveLength(4);
    expect(conicGradientFromShades(shades)).toMatch(
      /^conic-gradient\([^)]+ 0deg 90deg, [^)]+ 90deg 180deg, [^)]+ 180deg 270deg, [^)]+ 270deg 360deg\)$/,
    );
  });
});
