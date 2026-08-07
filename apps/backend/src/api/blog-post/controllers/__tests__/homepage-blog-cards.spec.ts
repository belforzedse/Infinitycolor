import routeConfig from "../../routes/custom-router";
import {
  HOMEPAGE_BLOG_CARD_LIMIT,
  buildHomepageBlogCardQuery,
  projectHomepageBlogCard,
} from "../homepage-blog-cards";

describe("homepage blog-card contract", () => {
  it("exposes a public dedicated route before the slug route", () => {
    expect(routeConfig.routes[0]).toEqual({
      method: "GET",
      path: "/blog-posts/homepage/cards",
      handler: "blog-post.findHomepage",
      config: {
        auth: false,
        middlewares: [],
        policies: [],
      },
    });
  });

  it("uses Entity Service offset pagination and an explicit card projection", () => {
    const query = buildHomepageBlogCardQuery();

    expect(query.start).toBe(0);
    expect(query.limit).toBe(HOMEPAGE_BLOG_CARD_LIMIT);
    expect(query).not.toHaveProperty("pagination");
    expect(query.filters).toEqual({ Status: "Published" });
    expect(query.sort).toEqual([{ PublishedAt: "desc" }, { id: "desc" }]);
    expect(query.fields).not.toContain("Content");
    expect(query.fields).not.toContain("MetaDescription");
    expect(query.populate).not.toHaveProperty("blog_tags");
    expect(query.populate).not.toHaveProperty("blog_comments");
  });

  it("drops rich content and private relation fields even if the data layer returns them", () => {
    const card = projectHomepageBlogCard({
      id: 1,
      Title: "Card title",
      Slug: "card-title",
      Content: "must-not-leak-rich-content",
      Excerpt: "Card excerpt",
      MetaDescription: "must-not-leak-seo",
      PublishedAt: "2026-08-07T00:00:00.000Z",
      createdAt: "2026-08-06T00:00:00.000Z",
      FeaturedImage: { id: 2, url: "/card.webp", hash: "must-not-leak-hash" },
      blog_category: { id: 3, Name: "Category", Slug: "category", private: "secret" },
      blog_author: { id: 4, Name: "Author", Email: "must-not-leak@example.test" },
      blog_tags: [{ id: 5, Name: "must-not-leak-tag" }],
    });

    expect(card).toEqual(
      expect.objectContaining({
        id: 1,
        Title: "Card title",
        Slug: "card-title",
        Excerpt: "Card excerpt",
      }),
    );
    expect(JSON.stringify(card)).not.toContain("must-not-leak");
  });
});
