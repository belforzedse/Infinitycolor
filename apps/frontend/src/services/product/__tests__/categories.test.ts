import { API_BASE_URL, ENDPOINTS } from "@/constants/api";
import fetchWithTimeout from "@/utils/fetchWithTimeout";
import {
  CategoryFetchError,
  getCachedNavigationProductCategories,
  getNavbarProductCategories,
  getProductCategories,
  getProductCategoriesForRender,
} from "../categories";

jest.mock("@/utils/fetchWithTimeout", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockedFetchWithTimeout = fetchWithTimeout as jest.MockedFunction<typeof fetchWithTimeout>;

describe("getProductCategories", () => {
  beforeEach(() => {
    mockedFetchWithTimeout.mockReset();
  });

  it("adds main category and parent filters when mainOnly is true", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await getProductCategories({ mainOnly: true, sort: "Title:asc" });

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(calledUrl as string);

    expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE_URL}${ENDPOINTS.PRODUCT.CATEGORY}`);
    expect(url.searchParams.get("filters[isMainCategory][$eq]")).toBe("true");
    expect(url.searchParams.get("filters[parent][id][$null]")).toBe("true");
    expect(url.searchParams.get("_skip_global_loader")).toBe("1");
    expect(url.searchParams.get("populate[1]")).toBe("MegaMenuImage");

    const fieldValues = Array.from(url.searchParams.entries())
      .filter(([key]) => key.startsWith("fields["))
      .map(([, value]) => value);
    expect(fieldValues).toContain("isMainCategory");
    expect(fieldValues).toContain("homepageOrder");
  });

  it("supports stable multi-field category ordering", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await getProductCategories({ sort: ["homepageOrder:asc", "Title:asc"] });

    const [calledUrl] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(calledUrl as string);
    expect(url.searchParams.get("sort[0]")).toBe("homepageOrder:asc");
    expect(url.searchParams.get("sort[1]")).toBe("Title:asc");
    expect(url.searchParams.has("sort")).toBe(false);
  });

  it("populates children when includeChildren is true", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await getProductCategories({ mainOnly: true, includeChildren: true });

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(calledUrl as string);

    expect(url.searchParams.get("populate[3]")).toBe("children");
  });

  it("normalizes isMainCategory as boolean in mapped output", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1,
            attributes: {
              Title: "Main",
              Slug: "main",
              isMainCategory: true,
              homepageOrder: 7,
              parent: { data: null },
            },
          },
          {
            id: 2,
            attributes: {
              Title: "Other",
              Slug: "other",
              parent: { data: null },
            },
          },
        ],
      }),
    } as Response);

    const categories = await getProductCategories();

    expect(categories).toHaveLength(2);
    expect(categories[0].isMainCategory).toBe(true);
    expect(categories[0].homepageOrder).toBe(7);
    expect(categories[1].isMainCategory).toBe(false);
    expect(categories[1].homepageOrder).toBe(1000);
  });

  it("maps mega menu image data and child categories", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1,
            attributes: {
              Title: "Parent",
              Slug: "parent",
              isMainCategory: true,
              parent: { data: null },
              Image: {
                data: {
                  attributes: {
                    url: "/uploads/category.webp",
                    alternativeText: "Category image",
                  },
                },
              },
              MegaMenuImage: {
                data: {
                  attributes: {
                    url: "/uploads/menu.webp",
                    alternativeText: "Menu image",
                    width: 363,
                    height: 430,
                  },
                },
              },
              children: {
                data: [
                  {
                    id: 2,
                    attributes: {
                      Title: "Child",
                      Slug: "child",
                      parent: { data: { id: 1 } },
                    },
                  },
                ],
              },
            },
          },
        ],
      }),
    } as Response);

    const categories = await getProductCategories({ includeChildren: true });

    expect(categories[0]).toMatchObject({
      id: 1,
      name: "Parent",
      slug: "parent",
      imageAlt: "Category image",
      megaMenuImageAlt: "Menu image",
      megaMenuImageWidth: 363,
      megaMenuImageHeight: 430,
      hasChildren: true,
    });
    expect(categories[0].imageUrl).toContain("/uploads/category.webp");
    expect(categories[0].megaMenuImageUrl).toContain("/uploads/menu.webp");
    expect(categories[0].children).toEqual([
      expect.objectContaining({
        id: 2,
        name: "Child",
        slug: "child",
        parentId: 1,
      }),
    ]);
  });

  it("uses a null mega menu image when the field is missing", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1,
            attributes: {
              Title: "No banner",
              Slug: "no-banner",
              parent: { data: null },
            },
          },
        ],
      }),
    } as Response);

    const categories = await getProductCategories();

    expect(categories[0].megaMenuImageUrl).toBeNull();
    expect(categories[0].megaMenuImageAlt).toBe("No banner");
  });

  it("reads categories assigned to the navigation single type", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          attributes: {
            product_categories: {
              data: [
                {
                  id: 10,
                  attributes: {
                    Title: "Assigned",
                    Slug: "assigned",
                    parent: { data: null },
                    children: {
                      data: [
                        {
                          id: 11,
                          attributes: {
                            Title: "Assigned child",
                            Slug: "assigned-child",
                            parent: { data: { id: 10 } },
                          },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          },
        },
      }),
    } as Response);

    const categories = await getNavbarProductCategories({ includeChildren: true });

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(calledUrl as string);

    expect(`${url.origin}${url.pathname}`).toBe(`${API_BASE_URL}/navigation`);
    expect(url.searchParams.get("populate[product_categories][populate][1]")).toBe("MegaMenuImage");
    expect(url.searchParams.get("populate[product_categories][populate][3]")).toBe("children");
    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({
      id: 10,
      name: "Assigned",
      slug: "assigned",
      children: [expect.objectContaining({ id: 11, slug: "assigned-child" })],
    });
  });

  it("reads navigation categories through the same-origin shared cache", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          id: 10,
          name: "Assigned",
          slug: "assigned",
          imageUrl: null,
          imageAlt: "Assigned",
          megaMenuImageUrl: null,
          megaMenuImageAlt: "Assigned",
          parentId: null,
          isMainCategory: true,
        },
      ],
    } as Response);

    const categories = await getCachedNavigationProductCategories({
      source: "catalog",
      includeChildren: true,
    });

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [calledUrl, requestInit] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(String(calledUrl), "https://storefront.test");
    expect(url.pathname).toBe("/api/storefront/navigation");
    expect(url.searchParams.get("includeChildren")).toBe("1");
    expect(url.searchParams.get("source")).toBe("catalog");
    expect(url.searchParams.get("_skip_global_loader")).toBe("1");
    expect(requestInit).toMatchObject({ cache: "default" });
    expect(categories.map((category) => category.slug)).toEqual(["assigned"]);
  });

  it("keeps parentOnly behavior unchanged when mainOnly is false", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await getProductCategories({ parentOnly: true });

    expect(mockedFetchWithTimeout).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockedFetchWithTimeout.mock.calls[0];
    const url = new URL(calledUrl as string);

    expect(url.searchParams.get("filters[parent][id][$null]")).toBe("true");
    expect(url.searchParams.get("filters[isMainCategory][$eq]")).toBeNull();
  });

  it("filters by allowedNameSubstrings when provided", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1,
            attributes: {
              Title: "کیف دستی",
              Slug: "bag",
              parent: { data: null },
            },
          },
          {
            id: 2,
            attributes: {
              Title: "دامن",
              Slug: "skirt",
              parent: { data: null },
            },
          },
          {
            id: 3,
            attributes: {
              Title: "پلیور",
              Slug: "pullover",
              parent: { data: null },
            },
          },
        ],
      }),
    } as Response);

    const categories = await getProductCategories({
      allowedNameSubstrings: ["کیف", "دامن"],
    });

    expect(categories).toHaveLength(2);
    expect(categories.map((c) => c.name)).toEqual(["کیف دستی", "دامن"]);
  });
});

describe("category fetch failure is distinct from an empty catalog", () => {
  beforeEach(() => {
    mockedFetchWithTimeout.mockReset();
  });

  it("resolves to an empty list for a successful empty response", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    } as Response);

    await expect(getProductCategories()).resolves.toEqual([]);
  });

  it("throws on a non-OK response instead of inventing an empty catalog", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      text: async () => "upstream down",
    } as Response);

    await expect(getProductCategories()).rejects.toBeInstanceOf(CategoryFetchError);
  });

  it("throws on a transport error", async () => {
    mockedFetchWithTimeout.mockRejectedValueOnce(new Error("network down"));

    await expect(getProductCategories()).rejects.toBeInstanceOf(CategoryFetchError);
  });

  it("throws when the navigation single type request fails", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: "Server Error",
      text: async () => "boom",
    } as Response);

    await expect(getNavbarProductCategories()).rejects.toBeInstanceOf(CategoryFetchError);
  });

  it("does not turn a cached navbar endpoint failure into an empty menu", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
    } as Response);

    await expect(
      getCachedNavigationProductCategories({ source: "assigned" }),
    ).rejects.toBeInstanceOf(CategoryFetchError);
  });

  it("still resolves to [] for a navigation single type with no assigned categories", async () => {
    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { attributes: {} } }),
    } as Response);

    await expect(getNavbarProductCategories()).resolves.toEqual([]);
  });

  it("degrades to [] for server rendering so a transient failure cannot 500 a page", async () => {
    mockedFetchWithTimeout.mockRejectedValueOnce(new Error("network down"));

    await expect(getProductCategoriesForRender()).resolves.toEqual([]);
  });

  it("recovers on the next call after a failure", async () => {
    mockedFetchWithTimeout.mockRejectedValueOnce(new Error("network down"));
    await expect(getProductCategories()).rejects.toBeInstanceOf(CategoryFetchError);

    mockedFetchWithTimeout.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [{ id: 1, attributes: { Title: "کیف", Slug: "bag", parent: { data: null } } }],
      }),
    } as Response);

    const categories = await getProductCategories();
    expect(categories.map((c) => c.slug)).toEqual(["bag"]);
  });
});
