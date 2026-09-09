import { render, screen } from "@testing-library/react";
import AboutSection from "../AboutSection";

describe("AboutSection", () => {
  it("renders the first about heading as h1 when requested", () => {
    render(
      <AboutSection title="اینفینیتی" titleAs="h1">
        <p>معرفی فروشگاه</p>
      </AboutSection>,
    );

    expect(screen.getByRole("heading", { level: 1, name: "اینفینیتی" })).toBeInTheDocument();
    expect(screen.getByText("معرفی فروشگاه")).toBeInTheDocument();
  });

  it("defaults later sections to h2", () => {
    render(
      <AboutSection title="تنوع محصولات">
        <p>توضیح دسته‌ها</p>
      </AboutSection>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "تنوع محصولات" })).toBeInTheDocument();
  });
});
