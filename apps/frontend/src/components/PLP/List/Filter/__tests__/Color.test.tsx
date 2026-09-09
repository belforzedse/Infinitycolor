import { fireEvent, render, screen } from "@testing-library/react";
import ColorFilter from "../Color";
import type { ColorFamilyBucket } from "@/utils/plpColorFilter";

const buckets: ColorFamilyBucket[] = [
  {
    key: "blue",
    label: "آبی",
    titles: ["E2E Blue", "آبی تیره"],
    shades: ["#D5F2FF", "#40AAFF", "#1D70C4", "#10265B"],
  },
  {
    key: "navy",
    label: "سرمه‌ای",
    titles: ["سرمه ای گلدار"],
    shades: ["#93C5FD", "#3B82F6", "#1E3A8A", "#010136"],
  },
];

describe("ColorFilter", () => {
  it("renders round four-shade swatches and selects a family", () => {
    const onToggle = jest.fn();
    render(<ColorFilter buckets={buckets} selectedKeys={[]} onToggle={onToggle} />);

    const swatch = screen.getAllByTestId("plp-color-swatch")[0];
    expect(swatch).toHaveClass("rounded-full");
    expect(swatch.getAttribute("style")).toContain("conic-gradient");
    expect(swatch.getAttribute("style")).toContain("90deg");

    fireEvent.click(screen.getByTestId("plp-color-option-blue"));
    expect(onToggle).toHaveBeenCalledWith("blue");
  });

  it("finds آبی via search", () => {
    render(<ColorFilter buckets={buckets} selectedKeys={[]} onToggle={jest.fn()} />);
    fireEvent.change(screen.getByRole("searchbox", { name: "جستجوی رنگ" }), {
      target: { value: "آبی" },
    });
    expect(screen.getByTestId("plp-color-option-blue")).toBeInTheDocument();
    expect(screen.queryByTestId("plp-color-option-navy")).not.toBeInTheDocument();
  });
});
