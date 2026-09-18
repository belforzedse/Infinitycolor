import type { CategoryFilterOption } from "@/services/product/categories";
import {
  buildMobileMenuTaxonomy,
  isSyntheticMobileMenuCategory,
} from "../mobileMenuTaxonomy";

const category = (
  id: number,
  name: string,
  slug: string,
  children: CategoryFilterOption[] = [],
): CategoryFilterOption => ({
  id,
  name,
  slug,
  parentId: null,
  children,
});

const catalog = [
  category(1, "پیراهن", "shirt"),
  category(2, "جوراب", "socks"),
  category(3, "انواع کفش", "shoes"),
  category(4, "دامن", "skirt", [category(41, "دامن بلند", "long-skirt")]),
  category(5, "شال", "shawls-and-scarves", [
    category(51, "شال نخی", "cotton-shawl"),
    category(52, "کلاه", "کلاه"),
  ]),
  category(6, "شلوار", "pants", [category(61, "شلوار جین", "jeans")]),
  category(7, "شومیز", "paperback-and-tonic"),
  category(8, "مانتو", "coat-and-mantle", [category(81, "مانتو کتی", "coat-blazer")]),
  category(9, "لباس زیر", "under-wear", [
    category(91, "نیم تنه کبریتی", "match-bust"),
    category(92, "ست نیم تنه شورت", "short-torso-set"),
    category(93, "لگ", "لگ"),
  ]),
  category(10, "راحتی", "house-dress"),
  category(11, "کیف", "کیف"),
  category(12, "پلیور", "پلیور-و-بافت"),
  category(13, "هودی", "hoodie-and-dores", [category(131, "سویشرت", "sweatshirt")]),
  category(14, "پالتو", "coat", [category(141, "شکت", "shacket")]),
  category(15, "بامبر", "بامبر"),
  category(16, "کاپشن و پافر", "jacket-and-puffer"),
  category(17, "شلوارک", "شوارک"),
  category(18, "دورس", "دورس"),
  category(19, "کمربند زنانه", "womens-belt"),
];

describe("buildMobileMenuTaxonomy", () => {
  it("orders groups and standalone categories to match the mobile merchandising tree", () => {
    const items = buildMobileMenuTaxonomy(catalog);

    expect(items.map((item) => (item.type === "group" ? item.label : item.category.name))).toEqual([
      "بالا تنه",
      "پایین تنه",
      "کفش",
      "شال",
      "کلاه",
      "جوراب",
      "کمربند",
      "لباس ورزشی",
      "لباس زیر",
      "کیف",
    ]);
  });

  it("renames and combines upper-body slots without flattening pants children", () => {
    const items = buildMobileMenuTaxonomy(catalog);
    const upperBody = items.find((item) => item.type === "group" && item.key === "upper-body");
    expect(upperBody?.type).toBe("group");
    if (upperBody?.type !== "group") return;

    expect(upperBody.categories.map((item) => item.name)).toEqual([
      "پلیور",
      "کت و بامبر",
      "هودی و دورس",
      "پالتو و مانتو",
      "پیراهن",
      "شومیز و تونیک",
    ]);

    const coatMantle = upperBody.categories.find((item) => item.name === "پالتو و مانتو");
    expect(coatMantle && isSyntheticMobileMenuCategory(coatMantle)).toBe(true);
    expect(coatMantle?.children?.map((child) => child.name)).toEqual([
      "پالتو",
      "شکت",
      "مانتو",
      "مانتو کتی",
    ]);

    const lowerBody = items.find((item) => item.type === "group" && item.key === "lower-body");
    expect(lowerBody?.type).toBe("group");
    if (lowerBody?.type !== "group") return;
    expect(lowerBody.categories.map((item) => item.name)).toEqual(["شلوار", "شلوارک", "دامن", "لگ"]);
    expect(lowerBody.categories[0]?.children?.map((child) => child.name)).toEqual(["شلوار جین"]);
  });

  it("promotes کلاه out of شال and aliases sportswear children", () => {
    const items = buildMobileMenuTaxonomy(catalog);
    const shawl = items.find((item) => item.type === "category" && item.key === "shawl");
    const hat = items.find((item) => item.type === "category" && item.key === "hat");
    const sportswear = items.find((item) => item.type === "group" && item.key === "sportswear");
    const underwear = items.find((item) => item.type === "category" && item.key === "underwear");

    expect(shawl?.type).toBe("category");
    expect(hat?.type).toBe("category");
    if (shawl?.type !== "category" || hat?.type !== "category") return;
    expect(shawl.category.children?.map((child) => child.name)).toEqual(["شال نخی"]);
    expect(hat.category).toMatchObject({ name: "کلاه", slug: "کلاه" });

    expect(sportswear?.type).toBe("group");
    if (sportswear?.type !== "group") return;
    expect(sportswear.categories.map((item) => item.name)).toEqual(["نیم تنه", "لگ", "شلوارک", "دامن"]);
    expect(sportswear.categories[0]?.slug).toBe("match-bust");

    expect(underwear?.type).toBe("category");
    if (underwear?.type !== "category") return;
    expect(underwear.category.children?.map((child) => child.name)).toEqual([
      "نیم تنه کبریتی",
      "ست نیم تنه شورت",
      "لگ",
    ]);
  });

  it("skips missing catalogue slots instead of rendering empty groups", () => {
    const items = buildMobileMenuTaxonomy([category(1, "پیراهن", "shirt")]);
    expect(items).toEqual([
      {
        type: "group",
        key: "upper-body",
        label: "بالا تنه",
        categories: [expect.objectContaining({ name: "پیراهن", slug: "shirt" })],
      },
    ]);
  });
});
