import { render, screen } from "@testing-library/react";

import ColorSwatches from "../ColorSwatches";

/**
 * Real catalog data pairs colours that are visually adjacent — the ONRUNING
 * F 00165 shoe carries سفید #FFFFFF next to طوسی #E0E0E0 — and the chips used
 * only a white border, so both read as one white blob and the stated colour
 * count looked wrong. Every swatch must keep a visible boundary.
 */
describe("ColorSwatches", () => {
  it("gives near-white swatches a visible boundary", () => {
    const { container } = render(
      <ColorSwatches colorCodes={["#FFFFFF", "#E0E0E0"]} colorsCount={2} />,
    );

    const chips = container.querySelectorAll('[style*="background-color"]');
    expect(chips).toHaveLength(2);
    chips.forEach((chip) => {
      expect(chip.className).toContain("shadow-[inset_0_0_0_1px_rgba(0,0,0,0.22)]");
    });
  });

  it("drops colours with no usable code so the chips match the counted colours", () => {
    // `calculateUniqueColorsCount` already excludes colour records without a
    // ColorCode (imported junk such as "کد1"), so the chips must too.
    const { container } = render(
      <ColorSwatches colorCodes={["#FFFFFF", "not-a-colour", "#212121"]} colorsCount={2} />,
    );

    expect(container.querySelectorAll('[style*="background-color"]')).toHaveLength(2);
  });

  it("announces the colour count for assistive technology", () => {
    render(<ColorSwatches colorCodes={["#FFFFFF", "#212121", "#E0E0E0"]} colorsCount={3} />);

    expect(screen.getByRole("img")).toHaveAttribute("aria-label", "۳ رنگ");
  });
});
