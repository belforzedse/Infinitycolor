import {
  ALLOWED_HOME_NAV_CATEGORY_NAME_SUBSTRINGS,
  HEADER_EXTRA_CATEGORIES,
  OPPSI_HEADER_ITEM,
  STOREFRONT_MAIN_CATEGORY_OPTIONS,
} from "../categories";

describe("OPPSI_HEADER_ITEM", () => {
  it("links to the Oppsi PLP search", () => {
    expect(OPPSI_HEADER_ITEM).toEqual({
      key: "oppsi",
      label: "Oppsi",
      href: "/plp?search=Oppsi",
    });
  });
});

describe("STOREFRONT_MAIN_CATEGORY_OPTIONS", () => {
  it("matches the homepage featured main-category rail", () => {
    expect(STOREFRONT_MAIN_CATEGORY_OPTIONS).toEqual({
      mainOnly: true,
      sort: "Title:asc",
      featuredOnly: true,
      allowedNameSubstrings: ALLOWED_HOME_NAV_CATEGORY_NAME_SUBSTRINGS,
    });
  });
});

describe("HEADER_EXTRA_CATEGORIES", () => {
  it("adds کمربند as a top-level header category", () => {
    expect(HEADER_EXTRA_CATEGORIES).toEqual([
      {
        id: -10001,
        name: "کمربند",
        slug: "womens-belt",
        megaMenuImageUrl: "/images/categories/womens-belt.jpg",
        megaMenuImageAlt: "کمربند",
        megaMenuImageWidth: 682,
        megaMenuImageHeight: 1024,
      },
    ]);
  });
});
