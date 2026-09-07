jest.mock("@/lib/central-auth", () => ({
  centralAuth: { tokenManager: { getToken: jest.fn().mockResolvedValue(null) } },
}));

import { blogService } from "../blog.service";

/**
 * The /blog page fetches 8 latest posts plus 8 for each of 12 categories. Every
 * one of those carried its full richtext body into the RSC payload, so the page
 * shipped ~12MB of script and took over four seconds to finish — for a page
 * that only ever renders titles, excerpts and cover images.
 *
 * The excerpt must survive: ShortContent is derived from the body before it is
 * dropped.
 */
const LONG_BODY = `<p>${"متن طولانی مقاله. ".repeat(500)}</p>`;

function mockResponse(body: string) {
  return {
    ok: true,
    json: async () => ({
      data: [
        {
          id: 1,
          attributes: {
            Title: "مقاله نمونه",
            Slug: "sample",
            Content: body,
            Status: "Published",
          },
        },
      ],
      meta: { pagination: { page: 1, pageSize: 10, pageCount: 1, total: 1 } },
    }),
  } as unknown as Response;
}

describe("blog listing payload", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("drops the article body from listing results", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(LONG_BODY)) as unknown as typeof fetch;

    const result = await blogService.getBlogPosts({ pageSize: 8 });

    expect(result.data[0].Content).toBe("");
  });

  it("still derives the card excerpt from the body", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(LONG_BODY)) as unknown as typeof fetch;

    const result = await blogService.getBlogPosts({ pageSize: 8 });

    expect(result.data[0].ShortContent).toBeTruthy();
    expect(result.data[0].ShortContent!.length).toBeLessThan(200);
  });

  it("keeps the body when a caller genuinely syndicates it", async () => {
    global.fetch = jest.fn().mockResolvedValue(mockResponse(LONG_BODY)) as unknown as typeof fetch;

    const result = await blogService.getBlogPosts({ pageSize: 20, includeContent: true });

    expect(result.data[0].Content).toBe(LONG_BODY);
  });
});
