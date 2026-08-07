export const HOMEPAGE_BLOG_CARD_LIMIT = 8;

const BLOG_CARD_FIELDS = ["Title", "Slug", "Excerpt", "PublishedAt", "createdAt"];

export function buildHomepageBlogCardQuery() {
  return {
    fields: BLOG_CARD_FIELDS,
    filters: { Status: "Published" },
    sort: [{ PublishedAt: "desc" }, { id: "desc" }],
    start: 0,
    limit: HOMEPAGE_BLOG_CARD_LIMIT,
    populate: {
      FeaturedImage: {
        fields: ["url", "alternativeText", "width", "height", "formats"],
      },
      blog_category: {
        fields: ["Name", "Title", "Slug"],
      },
      blog_author: {
        fields: ["Name"],
      },
    },
  };
}

function projectImage(image: any) {
  if (!image) return undefined;
  return {
    id: image.id,
    url: image.url,
    alternativeText: image.alternativeText,
    width: image.width,
    height: image.height,
    formats: image.formats,
  };
}

function projectCategory(category: any) {
  if (!category) return undefined;
  return {
    id: category.id,
    Name: category.Name,
    Title: category.Title,
    Slug: category.Slug,
  };
}

function projectAuthor(author: any) {
  if (!author) return undefined;
  return {
    id: author.id,
    Name: author.Name,
  };
}

export function projectHomepageBlogCard(post: any) {
  return {
    id: post.id,
    Title: post.Title,
    Slug: post.Slug,
    Excerpt: post.Excerpt,
    PublishedAt: post.PublishedAt,
    createdAt: post.createdAt,
    FeaturedImage: projectImage(post.FeaturedImage),
    blog_category: projectCategory(post.blog_category),
    blog_author: projectAuthor(post.blog_author),
  };
}
