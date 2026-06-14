import { API_BASE_URL, ENDPOINTS } from "@/constants/api";
import fetchWithTimeout from "@/utils/fetchWithTimeout";
import { getNavbarProductCategories, getProductCategories } from "../categories";

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
    expect(categories[1].isMainCategory).toBe(false);
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
    expect(url.searchParams.get("populate[product_categories][populate][1]")).toBe(
      "MegaMenuImage",
    );
    expect(url.searchParams.get("populate[product_categories][populate][3]")).toBe("children");
    expect(categories).toHaveLength(1);
    expect(categories[0]).toMatchObject({
      id: 10,
      name: "Assigned",
      slug: "assigned",
      children: [expect.objectContaining({ id: 11, slug: "assigned-child" })],
    });
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
