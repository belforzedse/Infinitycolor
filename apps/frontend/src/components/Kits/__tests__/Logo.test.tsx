import { render, screen } from "@testing-library/react";
import { StorefrontLogo } from "@repo/brand";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

describe("StorefrontLogo", () => {
  it("should render logo image", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    expect(img).toBeInTheDocument();
  });

  it("should render as a link to home page", () => {
    render(<StorefrontLogo />);

    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/");
  });

  it("should use correct image source", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    const optimizedSource = new URL(
      img.getAttribute("src") || "",
      "http://localhost",
    );
    expect(optimizedSource.pathname).toBe("/_next/image");
    expect(optimizedSource.searchParams.get("url")).toBe(
      "/images/full-logo.png",
    );
  });

  it("should preload rather than lazy-load the storefront logo", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    expect(img).not.toHaveAttribute("loading", "lazy");
    expect(img).toHaveAttribute("srcset");
  });

  it("should have responsive sizes", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    expect(img).toHaveAttribute("sizes", "(max-width: 768px) 150px, 210px");
  });

  it("should pass intrinsic dimensions for layout", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    expect(img).toHaveAttribute("width", "210");
    expect(img).toHaveAttribute("height", "72");
  });

  it("should use object-fit contain in style", () => {
    render(<StorefrontLogo />);

    const img = screen.getByAltText("Logo");
    expect(img).toHaveStyle({ objectFit: "contain" });
  });

  it("should honor fixed width and height when provided", () => {
    render(<StorefrontLogo width={92} height={58} />);

    const img = screen.getByAltText("Logo");
    expect(img).toHaveAttribute("width", "92");
    expect(img).toHaveAttribute("height", "58");
    expect(img).toHaveStyle({ width: "92px", height: "58px", objectFit: "contain" });
  });
});
