import { render, screen } from "@testing-library/react";
import BlogSidebarSearch from "../BlogSidebarSearch";
import BlogSidebarCategories from "../BlogSidebarCategories";
import BlogSidebarToc from "../BlogSidebarToc";
import BlogSidebarPopular from "../BlogSidebarPopular";
import type { BlogCardPost, BlogCategory } from "@/services/blog/blog.service";

jest.mock("@/components/Blog/BlogCard", () => ({
  __esModule: true,
  default: ({ post }: { post: { Title: string; Slug: string } }) => (
    <a href={`/${post.Slug}`}>{post.Title}</a>
  ),
}));

class MockIntersectionObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

Object.defineProperty(global, "IntersectionObserver", {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

const categories: BlogCategory[] = [
  {
    id: 1,
    Name: "آموزشی",
    Title: "آموزشی",
    Slug: "educational",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    Name: "مد",
    Title: "مد و پوشاک",
    Slug: "fashion",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
];

const popularPosts: BlogCardPost[] = [
  {
    id: 10,
    Title: "نحوه شستن صحیح پوشاک",
    Slug: "washing-guide",
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("Blog post sidebar", () => {
  it("posts search queries to the blog listing", () => {
    render(<BlogSidebarSearch />);

    const form = screen.getByTestId("blog-sidebar-search");
    expect(form).toHaveAttribute("action", "/blog");
    expect(form).toHaveAttribute("method", "get");
    expect(screen.getByRole("searchbox", { name: "جستجو در مقالات" })).toHaveAttribute(
      "name",
      "search",
    );
  });

  it("links همه and each category, highlighting the current post category", () => {
    render(<BlogSidebarCategories categories={categories} activeSlug="educational" />);

    expect(screen.getByRole("link", { name: "همه" })).toHaveAttribute("href", "/blog");
    expect(screen.getByRole("link", { name: "آموزشی" })).toHaveAttribute(
      "href",
      "/blog?category=educational",
    );
    expect(screen.getByRole("link", { name: "مد و پوشاک" })).toHaveAttribute(
      "href",
      "/blog?category=fashion",
    );

    expect(screen.getByRole("link", { name: "آموزشی" })).toHaveClass("bg-infinity-primary");
    expect(screen.getByRole("link", { name: "همه" })).not.toHaveClass("bg-infinity-primary");
  });

  it("keeps categories hidden on small screens when the slot class is applied", () => {
    render(
      <div className="hidden lg:block" data-testid="blog-sidebar-categories-slot">
        <BlogSidebarCategories categories={categories} activeSlug="educational" />
      </div>,
    );

    expect(screen.getByTestId("blog-sidebar-categories-slot")).toHaveClass("hidden", "lg:block");
  });

  it("renders TOC anchors for article headings", () => {
    render(
      <BlogSidebarToc
        headings={[
          { id: "section-1", text: "راهنمای انتخاب لباس", level: 2 },
          { id: "section-2", text: "انتخاب سایز مناسب", level: 3 },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "راهنمای انتخاب لباس" })).toHaveAttribute(
      "href",
      "#section-1",
    );
    expect(screen.getByRole("link", { name: "انتخاب سایز مناسب" })).toHaveAttribute(
      "href",
      "#section-2",
    );
  });

  it("renders most-viewed cards", () => {
    render(<BlogSidebarPopular posts={popularPosts} />);

    expect(screen.getByRole("link", { name: "نحوه شستن صحیح پوشاک" })).toHaveAttribute(
      "href",
      "/washing-guide",
    );
  });

  it("keeps most-viewed in the sidebar stack on desktop", () => {
    render(
      <div className="contents min-w-0 lg:flex lg:flex-col lg:gap-4">
        <BlogSidebarSearch />
        <BlogSidebarPopular className="order-5 lg:order-none" posts={popularPosts} />
      </div>,
    );

    expect(screen.getByTestId("blog-sidebar-popular")).toHaveClass("order-5", "lg:order-none");
  });
});
