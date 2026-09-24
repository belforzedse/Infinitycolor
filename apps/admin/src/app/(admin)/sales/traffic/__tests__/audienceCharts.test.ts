import {
  CATEGORICAL_PALETTE as AUDIENCE_PALETTE,
  OTHER_COLOR,
  UNKNOWN_COLOR,
} from "@/components/SuperAdmin/reports/shared/chartTheme";
import { buildComposition } from "../audienceCharts";

const row = (label: string, visitors: number, extra: Record<string, number> = {}) => ({
  label,
  visitors,
  ...extra,
});

describe("audience composition", () => {
  it("splits visitors into shares that include the unknown part", () => {
    const composition = buildComposition("device", [
      row("mobile", 900, { visits: 1000, bounces: 400, pageviews: 3000, totaltime: 60000 }),
      row("laptop", 60),
      row("Unknown", 40),
    ])!;
    expect(composition.total).toBe(1000);
    expect(composition.segments.map((segment) => [segment.label, segment.share])).toEqual([
      ["موبایل", 0.9],
      ["رایانه همراه", 0.06],
      ["نامشخص", 0.04],
    ]);
    const [mobile] = composition.segments;
    expect(mobile.bounceRate).toBeCloseTo(0.4);
    expect(mobile.pagesPerVisit).toBeCloseTo(3);
    expect(mobile.avgDuration).toBeCloseTo(60);
    expect(composition.segments[2].color).toBe(UNKNOWN_COLOR);
  });

  it("keeps each group's colour when a filter removes a bigger one", () => {
    const full = buildComposition("os", [row("Android OS", 600), row("iOS", 300), row("Windows 10", 100)])!;
    const withoutAndroid = buildComposition("os", [row("iOS", 300), row("Windows 10", 100)])!;
    const colour = (composition: typeof full, label: string) =>
      composition.segments.find((segment) => segment.key === label)?.color;
    expect(colour(full, "iOS")).toBe(colour(withoutAndroid, "iOS"));
    expect(colour(full, "Windows 10")).toBe(colour(withoutAndroid, "Windows 10"));
    // Apple is the same colour as an OS and as a browser.
    const browsers = buildComposition("browser", [row("chrome", 5), row("ios", 3)])!;
    expect(colour(full, "iOS")).toBe(browsers.segments.find((segment) => segment.key === "ios")?.color);
  });

  it("folds everything past five named groups into «سایر» with its members", () => {
    const composition = buildComposition(
      "browser",
      ["chrome", "ios", "instagram", "chromium-webview", "samsung", "firefox", "edge"].map((label, index) =>
        row(label, 100 - index * 10),
      ),
    )!;
    const colours = composition.segments.filter((segment) => segment.kind === "named").map((segment) => segment.color);
    expect(new Set(colours).size).toBe(5);
    expect(colours.every((colour) => (AUDIENCE_PALETTE as readonly string[]).includes(colour))).toBe(true);
    const other = composition.segments.at(-1)!;
    expect(other).toMatchObject({ kind: "other", label: "سایر", color: OTHER_COLOR });
    expect(other.members?.map((member) => member.label)).toEqual(["Firefox", "Microsoft Edge"]);
    expect(other.visitors).toBe(90);
  });

  it("gives an unmapped value a colour no present group owns", () => {
    const composition = buildComposition("device", [row("smarttv", 50), row("mobile", 40)])!;
    const [tv, mobile] = composition.segments;
    expect(mobile.color).toBe(AUDIENCE_PALETTE[0]);
    expect(tv.color).not.toBe(mobile.color);
  });

  it("states the change in share in points, and nothing without a comparison", () => {
    const composition = buildComposition(
      "os",
      [row("iOS", 400), row("Android OS", 600)],
      [row("iOS", 300), row("Android OS", 700)],
    )!;
    const ios = composition.segments.find((segment) => segment.key === "iOS")!;
    expect(ios.previousShare).toBeCloseTo(0.3);
    expect(ios.changePp).toBeCloseTo(10);
    expect(buildComposition("os", [row("iOS", 1)])!.segments[0].changePp).toBeNull();
  });

  it("has nothing to draw without visitors", () => {
    expect(buildComposition("device", [])).toBeNull();
    expect(buildComposition("device", undefined)).toBeNull();
    expect(buildComposition("device", [row("mobile", 0)])).toBeNull();
  });
});
