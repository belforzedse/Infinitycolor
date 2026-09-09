import { withHeaderExtraCategories } from "../headerExtraCategories";
import type { ProductCategorySummary } from "@/services/product/categories";

const category = (
  id: number,
  name: string,
  slug: string,
  children: ProductCategorySummary[] = [],
): ProductCategorySummary => ({
  id,
  name,
  slug,
  imageUrl: null,
  imageAlt: name,
  megaMenuImageUrl: null,
  megaMenuImageAlt: name,
  parentId: null,
  isMainCategory: true,
  featured: false,
  hasChildren: children.length > 0,
  children,
});

describe("withHeaderExtraCategories", () => {
  it("adds کمربند as a top-level navbar category", () => {
    const shirts = category(1, "پیراهن", "shirt");
    const result = withHeaderExtraCategories([shirts]);

    expect(result.map((item) => item.slug)).toEqual(["shirt", "womens-belt"]);
    expect(result.at(-1)).toMatchObject({
      name: "کمربند",
      slug: "womens-belt",
      parentId: null,
      isMainCategory: true,
      children: [],
      megaMenuImageUrl: "/images/categories/womens-belt.jpg",
      megaMenuImageAlt: "کمربند",
      megaMenuImageWidth: 682,
      megaMenuImageHeight: 1024,
    });
  });

  it("does not duplicate کمربند when Navigation already includes it", () => {
    const existing = category(1057, "کمربند زنانه", "womens-belt");
    const result = withHeaderExtraCategories([existing]);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("کمربند زنانه");
    expect(result[0]?.megaMenuImageUrl).toBe("/images/categories/womens-belt.jpg");
  });

  it("keeps a CMS megamenu image when کمربند is already assigned", () => {
    const existing = {
      ...category(1057, "کمربند زنانه", "womens-belt"),
      megaMenuImageUrl: "/uploads/cms-belt.webp",
      megaMenuImageAlt: "کمربند زنانه",
    };
    const result = withHeaderExtraCategories([existing]);

    expect(result).toHaveLength(1);
    expect(result[0]?.megaMenuImageUrl).toBe("/uploads/cms-belt.webp");
    expect(result[0]?.megaMenuImageAlt).toBe("کمربند زنانه");
  });
});
