import React from "react";
import { render, screen } from "@testing-library/react";
import BlogPromoSection from "../BlogPromoSection";
import type { PromoData } from "@/utils/blogShortcodes";

jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ src, alt, ...rest }: any) => <img src={src} alt={alt} {...rest} />,
}));

jest.mock("@/utils/resolveAssetUrl", () => ({
  __esModule: true,
  default: (path: string) => `https://cdn.test${path}`,
  resolveAssetUrl: (path: string) => `https://cdn.test${path}`,
}));

// Real data extracted from the live article `clothing-colors-for-wheat-skin`.
const promo: PromoData = {
  title: "مانتوهای ما، انتخابی دلچسب!",
  body: "زیبایی و انطباق با مد را با ما تجربه کنید",
  cta: { label: "مشاهده محصولات", href: "/plp/category/coat-and-mantle" },
  social: {
    label: "Infinity.color_boutique",
    href: "https://instagram.com/infinity.color_boutique",
  },
  image: { url: "/uploads/blog-temp-pic1.png", alt: "" },
  variant: "pic1",
};

describe("BlogPromoSection", () => {
  it("renders every field of the imported block", () => {
    const { container } = render(<BlogPromoSection data={promo} />);
    expect(screen.getByText("مانتوهای ما، انتخابی دلچسب!")).toBeInTheDocument();
    expect(screen.getByText("زیبایی و انطباق با مد را با ما تجربه کنید")).toBeInTheDocument();

    const cta = screen.getByRole("link", { name: "مشاهده محصولات" });
    expect(cta).toHaveAttribute("href", "/plp/category/coat-and-mantle");
    // An internal link stays in the tab.
    expect(cta).not.toHaveAttribute("target");

    const social = screen.getByRole("link", { name: "Infinity.color_boutique" });
    expect(social).toHaveAttribute("href", "https://instagram.com/infinity.color_boutique");
    expect(social).toHaveAttribute("rel", "noopener noreferrer");
    expect(social).toHaveAttribute("target", "_blank");

    // The illustration is decorative (empty alt), so it is queried by element.
    expect(container.querySelector("img")).toHaveAttribute(
      "src",
      "https://cdn.test/uploads/blog-temp-pic1.png",
    );
  });

  it("is right-to-left and does not inherit article typography", () => {
    const { container } = render(<BlogPromoSection data={promo} />);
    const section = container.querySelector("section")!;
    expect(section).toHaveAttribute("dir", "rtl");
    expect(section.className).toContain("not-prose");
  });

  it("renders text as text, never as markup", () => {
    const { container } = render(
      <BlogPromoSection
        data={{
          ...promo,
          title: '<img src=x onerror="alert(1)">',
          body: "<script>alert(1)</script>",
        }}
      />,
    );
    expect(container.querySelector("script")).toBeNull();
    // The only image is the promo illustration, not one smuggled in via text.
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByText('<img src=x onerror="alert(1)">')).toBeInTheDocument();
  });

  it("renders without a CTA, social link or image", () => {
    const { container } = render(
      <BlogPromoSection
        data={{ title: "عنوان", body: "", cta: null, social: null, image: null, variant: null }}
      />,
    );
    expect(screen.getByText("عنوان")).toBeInTheDocument();
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});
