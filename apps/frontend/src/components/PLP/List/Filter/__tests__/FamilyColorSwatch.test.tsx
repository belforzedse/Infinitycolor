import { render } from "@testing-library/react";
import FamilyColorSwatch from "../FamilyColorSwatch";

describe("FamilyColorSwatch", () => {
  it("paints a small round conic pie with four shades", () => {
    const { container } = render(
      <FamilyColorSwatch
        label="سبز"
        shades={["#E4F5DC", "#A8D98A", "#4C9A3A", "#1B4332"]}
      />,
    );
    const swatch = container.querySelector('[data-testid="plp-color-swatch"]');
    expect(swatch).toHaveClass("rounded-full", "h-5", "w-5");
    expect(swatch).toHaveAttribute(
      "style",
      expect.stringContaining("conic-gradient"),
    );
    expect(swatch?.getAttribute("data-shades")?.split(",")).toHaveLength(4);
  });
});
