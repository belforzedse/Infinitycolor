import {
  buildSizeBuckets,
  expandSizeKeysToTitles,
  sizeBucketMatchesQuery,
  sizeFilterChipLabel,
  sizeKeysFromTitle,
} from "../plpSizeFilter";

describe("sizeKeysFromTitle", () => {
  it("maps 3xl aliases onto the 3xl bucket and keeps numeric 3 separate", () => {
    expect(sizeKeysFromTitle("3xl")).toEqual(["3xl"]);
    expect(sizeKeysFromTitle("3XL")).toEqual(["3xl"]);
    expect(sizeKeysFromTitle("XXXL")).toEqual(["3xl"]);
    expect(sizeKeysFromTitle("xxxl")).toEqual(["3xl"]);
    expect(sizeKeysFromTitle("سایز 3")).toEqual(["3"]);
    expect(sizeKeysFromTitle("سایز3")).toEqual(["3"]);
    expect(sizeKeysFromTitle("3")).toEqual(["3"]);
  });

  it("maps range titles onto both sides", () => {
    expect(sizeKeysFromTitle("2XL/3XL").sort()).toEqual(["2xl", "3xl"]);
    expect(sizeKeysFromTitle("L/XL").sort()).toEqual(["l", "xl"]);
    expect(sizeKeysFromTitle("S/M(1)").sort()).toEqual(["m", "s"]);
  });

  it("maps english e2e titles and free size", () => {
    expect(sizeKeysFromTitle("E2E Medium")).toEqual(["m"]);
    expect(sizeKeysFromTitle("E2E Large")).toEqual(["l"]);
    expect(sizeKeysFromTitle("فری سایز")).toEqual(["free"]);
  });

  it("treats 37/5 as a decimal instead of a range", () => {
    expect(sizeKeysFromTitle("37/5")).toEqual(["37.5"]);
  });
});

describe("expandSizeKeysToTitles", () => {
  it("expands 3xl to every matching catalog and static alias title", () => {
    const titles = expandSizeKeysToTitles(
      ["3xl"],
      ["3xl", "XXXL", "2XL/3XL", "M", "سایز 3"],
    );
    expect(titles).toEqual(expect.arrayContaining(["3xl", "XXXL", "2XL/3XL"]));
    expect(titles).not.toEqual(expect.arrayContaining(["M", "سایز 3"]));
  });
});

describe("buildSizeBuckets", () => {
  it("only emits buckets that exist in the catalog and searches xxxl onto 3XL", () => {
    const buckets = buildSizeBuckets(["3xl", "XXXL", "M", "سایز 3", "36"]);
    expect(buckets.map((bucket) => bucket.key)).toEqual(["m", "3xl", "3", "36"]);
    const xl3 = buckets.find((bucket) => bucket.key === "3xl");
    expect(xl3?.label).toBe("3XL");
    expect(xl3 && sizeBucketMatchesQuery(xl3, "xxxl")).toBe(true);
    expect(xl3 && sizeBucketMatchesQuery(xl3, "۳xl")).toBe(true);
    expect(sizeFilterChipLabel("3xl")).toBe("3XL");
  });
});
