import React from "react";
import { render, screen } from "@testing-library/react";
import BlogContentRenderer from "../BlogContentRenderer";

jest.mock("../BlogProductCarousel", () => ({
  __esModule: true,
  default: ({ identifiers }: { identifiers: string[] }) => (
    <div data-testid="carousel">{identifiers.join("|")}</div>
  ),
}));

jest.mock("../BlogPromoSection", () => ({
  __esModule: true,
  default: ({ data }: any) => <div data-testid="promo">{data.title}</div>,
}));

describe("BlogContentRenderer", () => {
  it("renders a carousel in place instead of leaving the marker as text", () => {
    const { container } = render(
      <BlogContentRenderer
        content={'<p>پیش از کاروسل</p>[products:"shal-nakhi",12]<p>پس از کاروسل</p>'}
      />,
    );
    expect(screen.getByTestId("carousel")).toHaveTextContent("shal-nakhi|12");
    expect(container.textContent).not.toContain("[products:");
    expect(screen.getByText("پیش از کاروسل")).toBeInTheDocument();
    expect(screen.getByText("پس از کاروسل")).toBeInTheDocument();
  });

  it("renders an entity-encoded marker the same way", () => {
    const { container } = render(
      <BlogContentRenderer content={"<p>متن &amp; بیشتر</p>[products:&quot;kif&quot;]"} />,
    );
    expect(screen.getByTestId("carousel")).toHaveTextContent("kif");
    expect(container.textContent).not.toContain("[products:");
  });

  it("renders a promotional block and keeps the article around it", () => {
    render(
      <BlogContentRenderer
        content={
          '<p>قبل</p>[promo:{"title":"مانتوهای ما","body":"متن","cta":{"label":"مشاهده","href":"/plp/category/coat-and-mantle"}}]<p>بعد</p>'
        }
      />,
    );
    expect(screen.getByTestId("promo")).toHaveTextContent("مانتوهای ما");
    expect(screen.getByText("قبل")).toBeInTheDocument();
    expect(screen.getByText("بعد")).toBeInTheDocument();
  });

  it("renders several blocks of both kinds in document order", () => {
    const { container } = render(
      <BlogContentRenderer
        content={
          '<p>a</p>[products:1]<p>b</p>[promo:{"title":"p","body":"q"}]<p>c</p>[products:2]'
        }
      />,
    );
    const rendered = Array.from(container.querySelectorAll("[data-testid]")).map(
      (node) => node.getAttribute("data-testid"),
    );
    expect(rendered).toEqual(["carousel", "promo", "carousel"]);
  });

  it("gives an article without blocks the same typography as one with them", () => {
    const plain = render(<BlogContentRenderer content={"<p>فقط متن</p>"} />);
    const withBlock = render(<BlogContentRenderer content={"<p>متن</p>[products:1]"} />);
    expect(plain.container.firstElementChild?.className).toBe(
      withBlock.container.firstElementChild?.className,
    );
  });

  it("still strips scripts out of the surrounding HTML", () => {
    const { container } = render(
      <BlogContentRenderer content={'<p>متن</p><script>alert(1)</script>[products:1]'} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByTestId("carousel")).toBeInTheDocument();
  });
});
