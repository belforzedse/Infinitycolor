/**
 * @jest-environment node
 */

import { getCategoryAndDescendantSlugs } from "@/utils/category-descendants";
import { getProductCategories } from "../categories";

const responseWithJson = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => body,
  }) as Response;

describe("getProductCategories server pagination", () => {
  beforeEach(() => {
    (global as any).fetch = jest.fn();
  });

  it("fetches every page when resolving the full category tree server-side", async () => {
    const fetchMock = global.fetch as jest.MockedFunction<typeof fetch>;
    fetchMock
      .mockResolvedValueOnce(
        responseWithJson({
          data: [
            {
              id: 172,
              attributes: {
                Title: "Child category",
                Slug: "child-category",
                parent: { data: { id: 171 } },
              },
            },
          ],
          meta: { pagination: { page: 1, pageSize: 100, pageCount: 2, total: 101 } },
        }),
      )
      .mockResolvedValueOnce(
        responseWithJson({
          data: [
            {
              id: 171,
              attributes: {
                Title: "Parent category",
                Slug: "parent-category",
                parent: { data: null },
              },
            },
          ],
          meta: { pagination: { page: 2, pageSize: 100, pageCount: 2, total: 101 } },
        }),
      );

    const categories = await getProductCategories({ revalidate: 3600 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map(([url]) => new URL(String(url)));
    expect(urls[0].searchParams.get("pagination[page]")).toBe("1");
    expect(urls[1].searchParams.get("pagination[page]")).toBe("2");
    expect(urls[0].searchParams.get("pagination[pageSize]")).toBe("100");
    expect(urls[0].searchParams.get("pagination[limit]")).toBeNull();

    expect(categories.map((category) => category.slug)).toEqual([
      "child-category",
      "parent-category",
    ]);
    expect(getCategoryAndDescendantSlugs(categories, "parent-category")).toEqual([
      "parent-category",
      "child-category",
    ]);
  });
});
