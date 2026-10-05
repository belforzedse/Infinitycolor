import { blogService } from "../blog.service";

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getTokenOutcome: jest.fn().mockResolvedValue({ state: "unauthenticated" }),
    },
  },
}));

const mockFetch = jest.fn();
global.fetch = mockFetch;

describe("homepage blog service", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("uses the dedicated endpoint and exposes only card fields", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 1,
            attributes: {
              Title: "Card title",
              Slug: "card-title",
              Excerpt: "Card excerpt",
              Content: "must-not-cross-the-client-boundary",
              PublishedAt: "2026-08-07T00:00:00.000Z",
              createdAt: "2026-08-06T00:00:00.000Z",
              blog_author: {
                data: {
                  id: 2,
                  attributes: {
                    Name: "Author",
                    Email: "must-not-leak@example.test",
                  },
                },
              },
            },
          },
        ],
      }),
    });

    const response = await blogService.getHomepageBlogPosts();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(new URL(url as string).pathname).toBe("/api/blog-posts/homepage/cards");
    expect(response.data).toEqual([
      expect.objectContaining({
        id: 1,
        Title: "Card title",
        Slug: "card-title",
        Excerpt: "Card excerpt",
        blog_author: { id: 2, Name: "Author" },
      }),
    ]);
    expect(JSON.stringify(response.data)).not.toContain("must-not");
  });

  it("fails explicitly when the bounded endpoint is unavailable", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false });

    await expect(blogService.getHomepageBlogPosts()).rejects.toThrow(
      "Failed to fetch homepage blog posts",
    );
  });
});
