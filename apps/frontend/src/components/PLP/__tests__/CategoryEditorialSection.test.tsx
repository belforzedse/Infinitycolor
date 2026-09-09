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
          audio: null,
          seoDescription: "پیش از خرید این نکات را بخوانید.",
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
    expect(container.querySelector(".prose")).toHaveClass("whitespace-pre-line");
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
          audio: null,
          seoDescription: "متن بلند",
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

  it("renders local audio between the introduction and body without autoplay", () => {
    const { container } = render(
      <CategoryEditorialSection
        editorial={{
          id: 7,
          title: "راهنمای صوتی",
          paragraph: "مقدمه",
          content: "<p>متن اصلی</p>",
          audio: {
            url: "/uploads/guide.mp3",
            name: "guide.mp3",
            mime: "audio/mpeg",
          },
          seoDescription: "مقدمه متن اصلی",
          isRtl: true,
          updatedAt: null,
        }}
      />,
    );
    const audio = screen.getByLabelText("فایل صوتی راهنمای صوتی");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("preload", "metadata");
    expect(audio).not.toHaveAttribute("autoplay");
    const paragraph = screen.getByText("مقدمه");
    const body = screen.getByText("متن اصلی");
    expect(paragraph.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(audio.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("audio")?.getAttribute("src")).toContain("/uploads/guide.mp3");
  });
});
