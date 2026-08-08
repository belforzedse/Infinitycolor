import blogPostLifecycles from "../lifecycles";

describe("blog-post lifecycles", () => {
  const originalEnv = process.env;
  const originalFetch = global.fetch;

  beforeEach(() => {
    // Storefront origins are configuration now. This used to be an unconditional
    // pair of hardcoded hostnames (staging + production), which is why the
    // assertion below was "2 calls" regardless of environment.
    process.env = {
      ...originalEnv,
      REVALIDATION_SECRET: "test-secret",
      NEXTJS_REVALIDATION_URL: "https://new.infinitycolor.co",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({ revalidated: true }),
      text: jest.fn().mockResolvedValue(""),
    } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
    global.fetch = originalFetch;
  });

  it("skips revalidation for counter-only updates", async () => {
    await blogPostLifecycles.afterUpdate({
      params: { data: { ViewCount: 42 } },
      result: { Status: "Published", Slug: "my-post" },
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("revalidates published posts for non-counter updates", async () => {
    await blogPostLifecycles.afterUpdate({
      params: { data: { Title: "Updated title" } },
      result: { Status: "Published", Slug: "my-post" },
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://new.infinitycolor.co/api/revalidate",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("notifies every configured storefront origin and no others", async () => {
    process.env.NEXTJS_REVALIDATION_URL = "https://a.example,https://b.example";

    await blogPostLifecycles.afterUpdate({
      params: { data: { Title: "Updated title" } },
      result: { Status: "Published", Slug: "my-post" },
    });

    const calledUrls = (global.fetch as jest.Mock).mock.calls.map(([url]) => url);
    expect(calledUrls).toEqual([
      "https://a.example/api/revalidate",
      "https://b.example/api/revalidate",
    ]);
  });

  it("does not leak a revalidation into another environment when unconfigured", async () => {
    delete process.env.NEXTJS_REVALIDATION_URL;
    delete process.env.FRONTEND_URL;

    await blogPostLifecycles.afterUpdate({
      params: { data: { Title: "Updated title" } },
      result: { Status: "Published", Slug: "my-post" },
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
