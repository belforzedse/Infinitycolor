import routeConfig from "../routes/custom-router";

describe("blog moderation route authorization", () => {
  it.each(["/blog-comments/:id/approve", "/blog-comments/:id/reject"])(
    "keeps %s behind the blog-comments capability",
    (path) => {
      const route = routeConfig.routes.find((entry) => entry.path === path);
      expect(route?.config.policies).toEqual([
        {
          name: "global::require-capability",
          config: { capability: "content.blog.comments.manage" },
        },
      ]);
    },
  );
});
