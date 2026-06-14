import { getCategoryAndDescendantSlugs, type CategoryWithParent } from "../category-descendants";

/**
 * Tree:
 *   clothing (1)
 *     ├─ tops (2)
 *     │   ├─ tshirts (4)
 *     │   └─ shirts (5)
 *     └─ bottoms (3)
 *   shoes (6)   [separate root]
 *   orphan (7)  [parentId points to a missing category]
 */
const CATEGORIES: CategoryWithParent[] = [
  { id: 1, slug: "clothing", parentId: null },
  { id: 2, slug: "tops", parentId: 1 },
  { id: 3, slug: "bottoms", parentId: 1 },
  { id: 4, slug: "tshirts", parentId: 2 },
  { id: 5, slug: "shirts", parentId: 2 },
  { id: 6, slug: "shoes", parentId: null },
  { id: 7, slug: "orphan", parentId: 999 },
];

describe("getCategoryAndDescendantSlugs", () => {
  it("includes the category itself plus all descendants (multi-level)", () => {
    const result = getCategoryAndDescendantSlugs(CATEGORIES, "clothing");
    expect(result[0]).toBe("clothing");
    expect(new Set(result)).toEqual(
      new Set(["clothing", "tops", "bottoms", "tshirts", "shirts"]),
    );
    expect(result).not.toContain("shoes");
  });

  it("includes grandchildren when starting from a mid-level parent", () => {
    const result = getCategoryAndDescendantSlugs(CATEGORIES, "tops");
    expect(new Set(result)).toEqual(new Set(["tops", "tshirts", "shirts"]));
  });

  it("returns only the slug for a leaf category", () => {
    expect(getCategoryAndDescendantSlugs(CATEGORIES, "tshirts")).toEqual(["tshirts"]);
    expect(getCategoryAndDescendantSlugs(CATEGORIES, "shoes")).toEqual(["shoes"]);
  });

  it("returns an empty array for an unknown slug", () => {
    expect(getCategoryAndDescendantSlugs(CATEGORIES, "missing")).toEqual([]);
  });

  it("handles empty input", () => {
    expect(getCategoryAndDescendantSlugs([], "clothing")).toEqual([]);
    expect(getCategoryAndDescendantSlugs(CATEGORIES, "")).toEqual([]);
  });

  it("treats a category with a missing parent as its own leaf", () => {
    expect(getCategoryAndDescendantSlugs(CATEGORIES, "orphan")).toEqual(["orphan"]);
  });
});
