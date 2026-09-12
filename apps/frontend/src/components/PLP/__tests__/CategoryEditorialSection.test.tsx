import { fireEvent, render, screen } from "@testing-library/react";
import CategoryEditorialSection, {
  CATEGORY_EDITORIAL_MOBILE_DISCLOSURE_THRESHOLD,
  needsMobileDisclosure,
} from "../CategoryEditorialSection";

jest.mock("@/components/Kits/Voice", () => ({
  __esModule: true,
  default: ({
    audioSrc,
    label,
    className,
  }: {
    audioSrc: string;
    label: string;
    className?: string;
  }) => (
    <div
      data-testid="category-editorial-audio"
      data-src={audioSrc}
      data-label={label}
      className={className}
    />
  ),
}));

describe("CategoryEditorialSection", () => {
  it("renders an H2 with crawlable links and lower-level body headings", () => {
    const { container } = render(
      <CategoryEditorialSection
        editorial={{
          id: 5,
          title: "راهنمای انتخاب روسری",
          paragraph: "پیش از خرید این نکات را بخوانید.",
          content:
            '<h3>جنس مناسب</h3><p><a href="/plp/category/شال">دیدن شال‌ها</a></p><table><tbody><tr><td>ابریشم</td></tr></tbody></table><img src="/guide.jpg" alt="راهنمای جنس پارچه">',
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
    expect(screen.getByRole("table")).toHaveTextContent("ابریشم");
    expect(screen.getByRole("img", { name: "راهنمای جنس پارچه" })).toHaveAttribute(
      "src",
      "/guide.jpg",
    );
    expect(container.querySelector("section")).toHaveAttribute("dir", "rtl");
    expect(container.querySelector("section")).toHaveClass("w-full", "py-6", "sm:py-10");
    expect(container.querySelector("section")).not.toHaveClass("border", "rounded-2xl", "bg-white");
    expect(container.querySelector("[data-aq-reveal-variant='fade-up']")).toHaveClass("max-w-5xl");
    expect(container.querySelector("section > div")).toHaveClass(
      "max-w-4xl",
      "me-auto",
      "text-start",
    );
    expect(container.querySelector(".prose")).toHaveClass(
      "whitespace-pre-line",
      "prose-table:overflow-x-auto",
      "prose-img:max-w-full",
    );
    expect(container.querySelector("h1")).toBeNull();
  });

  it("uses logical alignment for left-to-right editorial content", () => {
    const { container } = render(
      <CategoryEditorialSection
        editorial={{
          id: 8,
          title: "Scarf buying guide",
          paragraph: "How to choose a scarf.",
          content: null,
          audio: null,
          seoDescription: "How to choose a scarf.",
          isRtl: false,
          updatedAt: null,
        }}
      />,
    );

    expect(container.querySelector("section")).toHaveAttribute("dir", "ltr");
    expect(container.querySelector("section > div")).toHaveClass("me-auto", "text-start");
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
    const panel = document.getElementById(toggle.getAttribute("aria-controls")!);
    expect(disclosure).toContainHTML("متن");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panel).toHaveAttribute("data-state", "closed");
    expect(panel).toHaveAttribute("data-aq-motion-sensitive");
    expect(toggle).toHaveAttribute("data-aq-motion-sensitive");
    expect(panel).toHaveClass("grid-rows-[0fr]", "opacity-0", "invisible", "duration-200");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "بستن متن" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(panel).toHaveAttribute("data-state", "open");
    expect(panel).toHaveClass("grid-rows-[1fr]", "opacity-100", "visible");
  });

  it("renders the waveform audio player after the introduction and body", () => {
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
    const audio = screen.getByTestId("category-editorial-audio");
    expect(audio).toHaveAttribute("data-label", "فایل صوتی راهنمای صوتی");
    expect(audio.getAttribute("data-src")).toContain("/uploads/guide.mp3");
    expect(audio).toHaveClass("mt-6");
    const paragraph = screen.getByText("مقدمه");
    const body = screen.getByText("متن اصلی");
    expect(paragraph.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.compareDocumentPosition(audio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("audio")).toBeNull();
  });
});
