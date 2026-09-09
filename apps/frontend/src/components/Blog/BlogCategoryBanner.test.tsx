import { fireEvent, render, screen } from "@testing-library/react";
import BlogCategoryBanner from "./BlogCategoryBanner";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    className,
  }: {
    src: string;
    alt: string;
    className?: string;
  }) => <img src={src} alt={alt} className={className} />,
}));

const categories = [
  ["نگهداری از پوشاک", "maintenance-of-clothes"],
  ["انواع استایل", "انواع-استایل"],
  ["لباس عروس", "لباس-عروس"],
] as const;

describe("BlogCategoryBanner", () => {
  it.each(categories)("links %s to its own encoded category destination", (title, slug) => {
    render(
      <BlogCategoryBanner
        title={title}
        href={`/blog?category=${encodeURIComponent(slug)}`}
        linkText={`مشاهده ${title}`}
      />,
    );

    expect(screen.getByRole("link", { name: title })).toHaveAttribute(
      "href",
      `/blog?category=${encodeURIComponent(slug)}`,
    );
  });

  it("makes both the image and the text area the same category link", () => {
    render(
      <BlogCategoryBanner
        title="پوست، مو و زیبایی"
        subtitle="هر چیزی که نیازه برای مراقب از خودت بدونی!"
        backgroundImage="https://cdn.example.com/category-banner.jpg"
        href="/blog?category=beauty"
        linkText="مشاهده دسته بندی"
      />,
    );

    const link = screen.getByRole("link", { name: "پوست، مو و زیبایی" });
    expect(link).toHaveAttribute("href", "/blog?category=beauty");
    expect(link.querySelector("img")).not.toBeNull();
    expect(link).toHaveTextContent("پوست، مو و زیبایی");
    expect(link).toHaveTextContent("مشاهده دسته بندی");
  });

  it("hides title, subtitle, and CTA when those fields are empty", () => {
    const { container } = render(
      <BlogCategoryBanner
        title="   "
        subtitle={undefined}
        linkText=""
        backgroundImage="https://cdn.example.com/category-banner.jpg"
        href="/blog?category=beauty"
        ariaLabel="آرایش پوست و مو و زیبایی"
      />,
    );

    expect(container.querySelector("h2")).toBeNull();
    expect(container.querySelector("p")).toBeNull();
    expect(screen.queryByText("مشاهده مقالات")).not.toBeInTheDocument();
    expect(screen.queryByText("مشاهده دسته بندی")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "آرایش پوست و مو و زیبایی" })).toHaveAttribute(
      "href",
      "/blog?category=beauty",
    );
  });

  it("renders nothing when there is no image and no visible text", () => {
    const { container } = render(
      <BlogCategoryBanner title={undefined} subtitle={undefined} href="/blog?category=beauty" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("remains a native link for mouse, touch, and keyboard activation", () => {
    render(
      <BlogCategoryBanner title="نگهداری از پوشاک" href="/blog?category=maintenance-of-clothes" />,
    );

    const link = screen.getByRole("link", { name: "نگهداری از پوشاک" });
    const activations: string[] = [];
    link.addEventListener("click", (event) => {
      event.preventDefault();
      activations.push((event as MouseEvent).detail === 0 ? "keyboard" : "pointer");
    });

    fireEvent.click(link, { detail: 1 });
    fireEvent.touchStart(link, { touches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.touchEnd(link, { changedTouches: [{ clientX: 20, clientY: 20 }] });
    fireEvent.click(link, { detail: 1 });
    fireEvent.click(link, { detail: 0 });

    expect(activations).toEqual(["pointer", "pointer", "keyboard"]);
    expect(link.tagName).toBe("A");
  });
});
