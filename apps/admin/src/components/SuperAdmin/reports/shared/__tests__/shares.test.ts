import { CATEGORICAL_PALETTE, OTHER_COLOR, UNKNOWN_COLOR } from "../chartTheme";
import { assignColors, buildShares, shareOf } from "../shares";

describe("part-to-whole shares", () => {
  const item = (key: string, value: number | null, extra: Record<string, boolean> = {}) => ({
    key,
    label: key,
    value,
    ...extra,
  });

  it("sorts, names the top five, folds the tail and keeps unknown apart", () => {
    const shares = buildShares([
      item("a", 10),
      item("b", 40),
      item("c", 5),
      item("d", 20),
      item("e", 8),
      item("f", 7),
      item("g", 3),
      item("?", 7, { unknown: true }),
    ])!;
    expect(shares.total).toBe(100);
    expect(shares.segments.map((segment) => segment.key)).toEqual(["b", "d", "a", "e", "f", "__other", "__unknown"]);
    const other = shares.segments[5];
    expect(other).toMatchObject({ kind: "other", label: "سایر", value: 8, color: OTHER_COLOR });
    expect(other.members?.map((member) => member.key)).toEqual(["c", "g"]);
    expect(shares.segments[6]).toMatchObject({ kind: "unknown", color: UNKNOWN_COLOR, share: 0.07 });
  });

  it("folds the server's own remainder row instead of naming it", () => {
    const shares = buildShares([item("x", 10), item("__other__", 90, { fold: true })])!;
    expect(shares.segments.map((segment) => segment.kind)).toEqual(["named", "other"]);
    expect(shares.segments[1].share).toBeCloseTo(0.9);
  });

  it("leaves out zero and negative rows and counts them", () => {
    const shares = buildShares([item("a", 30), item("b", -5), item("c", 0), item("d", null)])!;
    expect(shares.total).toBe(30);
    expect(shares.excluded).toBe(3);
    expect(buildShares([item("a", -1)])).toBeNull();
  });

  it("keeps a group's colour whatever its rank", () => {
    const colors = assignColors(["wallet", "samankish"], { samankish: 0, wallet: 3 });
    expect(colors.get("samankish")).toBe(CATEGORICAL_PALETTE[0]);
    expect(colors.get("wallet")).toBe(CATEGORICAL_PALETTE[3]);
    // Without a slot, a key borrows the first slot no present key owns.
    expect(assignColors(["new", "samankish"], { samankish: 0 }).get("new")).toBe(CATEGORICAL_PALETTE[1]);
  });

  it("gives a share only for a positive value", () => {
    expect(shareOf(25, 100)).toBe(0.25);
    expect(shareOf(-5, 100)).toBeNull();
    expect(shareOf(5, 0)).toBeNull();
    expect(shareOf(null, 100)).toBeNull();
  });
});
