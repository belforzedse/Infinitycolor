import { fireEvent, render, screen } from "@testing-library/react";
import CategoryEditorialSection, {
  CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD,
  needsMobileDisclosure,
} from "../CategoryEditorialSection";

describe("CategoryEditorialSection", () => {
  it("renders an H2 with crawlable links and lower-level body headings", () => {
    const { container } = render(
      <CategoryEditorialSection
        editorial={{
          id: 5,
          title: "راهنمای انتخاب روسری",
          paragraph: "پیش از خرید این نکات را بخوانید.",
          content: '<h3>جنس مناسب</h3><p><a href="/plp/category/شال">دیدن شال‌ها</a></p>',
          isRtl: true,
          updatedAt: null,
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2 })).toHaveTextContent("راهنمای انتخاب روسری");
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("جنس مناسب");
    expect(screen.getByRole("link", { name: "دیدن شال‌ها" })).toHaveAttribute(
      "href",
      "/plp/category/شال",
    );
    expect(container.querySelector("section")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("h1")).toBeNull();
  });

  it("adds the accessible mobile disclosure only above the tested threshold", () => {
    expect(
      needsMobileDisclosure(`<p>${"ا".repeat(CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD)}</p>`),
    ).toBe(false);
    expect(
      needsMobileDisclosure(
        `<p>${"ا".repeat(CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD + 1)}</p>`,
      ),
    ).toBe(true);
    render(
      <CategoryEditorialSection
        editorial={{
          id: 6,
          title: "راهنمای بلند",
          paragraph: null,
          content: `<p>${"متن ".repeat(400)}</p>`,
          isRtl: true,
          updatedAt: null,
        }}
      />,
    );
    const disclosure = screen.getByTestId("category-editorial-disclosure");
    const toggle = screen.getByRole("button", { name: "ادامه مطلب" });
    expect(disclosure).toContainHTML("متن");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "بستن متن" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});
