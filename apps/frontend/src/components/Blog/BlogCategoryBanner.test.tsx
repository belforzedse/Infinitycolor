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

describe("BlogCategoryBanner sizing", () => {
  it("uses the image's own ratio so mobile is the desktop banner scaled down", () => {
    render(
      <BlogCategoryBanner
        title="انواع استایل"
        href="/blog?category=style"
        backgroundImage="/uploads/style.jpg"
        imageWidth={1600}
        imageHeight={500}
      />,
    );

    const banner = screen.getByRole("link", { name: "انواع استایل" });
    expect(banner).toHaveStyle({ aspectRatio: "1600 / 500" });
    // The fixed pixel heights are what made the phone crop differ from desktop.
    expect(banner.className).not.toMatch(/h-\[\d+px\]/);
  });

  it("falls back to a fixed ratio when the CMS reported no dimensions", () => {
    render(
      <BlogCategoryBanner
        title="لباس عروس"
        href="/blog?category=bridal"
        backgroundImage="/uploads/bridal.jpg"
      />,
    );

    expect(screen.getByRole("link", { name: "لباس عروس" })).toHaveStyle({
      aspectRatio: "16 / 9",
    });
  });

  it("ignores unusable dimensions rather than producing a zero-height box", () => {
    render(
      <BlogCategoryBanner
        title="نگهداری از پوشاک"
        href="/blog?category=care"
        backgroundImage="/uploads/care.jpg"
        imageWidth={0}
        imageHeight={0}
      />,
    );

    expect(screen.getByRole("link", { name: "نگهداری از پوشاک" })).toHaveStyle({
      aspectRatio: "16 / 9",
    });
  });

  it("scales the overlay with the box instead of stepping at a breakpoint", () => {
    render(
      <BlogCategoryBanner
        title="انواع استایل"
        subtitle="زیرنویس"
        href="/blog?category=style"
        backgroundImage="/uploads/style.jpg"
        imageWidth={1600}
        imageHeight={500}
      />,
    );

    expect(screen.getByRole("heading", { name: "انواع استایل" })).toHaveStyle({
      fontSize: "clamp(1.5rem, 4.8vw, 66px)",
    });
    expect(screen.getByText("زیرنویس")).toHaveStyle({
      fontSize: "clamp(0.875rem, 2.2vw, 30px)",
    });
  });
});
