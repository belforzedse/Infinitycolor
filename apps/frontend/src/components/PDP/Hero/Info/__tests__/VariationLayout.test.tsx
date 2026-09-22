import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import Color from "../Color";
import GenericAttributes from "../GenericAttributes";
import Size from "../Size";
import type { GenericAttributeSelector } from "@/services/product/product";

jest.mock("../../SizeModal", () => ({
  __esModule: true,
  default: () => null,
}));

/**
 * Colour terms used to be bare dots inside sideways scrollers: the name was only
 * in a tooltip and anything past the fold needed a scroll gesture. They now render
 * as swatch-over-name cards that wrap onto extra rows.
 */
describe("PDP variation selectors", () => {
  const colors = [
    { id: "1", title: "کرم", colorCode: "#E9DCD0" },
    { id: "2", title: "قهوه ای", colorCode: "#533030" },
    { id: "3", title: "طرح راه راه", colorCode: null },
  ];

  it("names every colour term on the card itself", () => {
    render(<Color colors={colors} selectedColor="1" />);

    const options = screen.getAllByTestId("pdp-color-option");

    expect(options).toHaveLength(3);
    expect(options.map((option) => option.textContent)).toEqual(["کرم", "قهوه ای", "طرح راه راه"]);
  });

  it("paints the swatch only when the term carries a hex, leaving a plain box otherwise", () => {
    const { container } = render(<Color colors={colors} selectedColor="1" />);

    const swatchOf = (title: string) =>
      container.querySelector<HTMLElement>(`[data-color-title="${title}"] > span`);

    expect(swatchOf("کرم")).toHaveStyle({ backgroundColor: "#E9DCD0" });
    expect(swatchOf("طرح راه راه")?.getAttribute("style")).toBeNull();
  });

  it("drops to plain name chips when no colour in the section has a hex", () => {
    const { container } = render(
      <Color
        colors={[
          { id: "1", title: "طرح گلدار", colorCode: null },
          { id: "2", title: "طرح راه راه", colorCode: "" },
        ]}
        selectedColor="1"
      />,
    );

    const options = screen.getAllByTestId("pdp-color-option");

    expect(options.map((option) => option.textContent)).toEqual(["طرح گلدار", "طرح راه راه"]);
    // No swatch strip: the chip is a label plus the radio marker, nothing painted.
    expect(container.querySelectorAll("[data-color-title] > span.h-\\[50px\\]")).toHaveLength(0);
    expect(options[0]).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the swatch cards when at least one colour in the section has a hex", () => {
    const { container } = render(<Color colors={colors} selectedColor="1" />);

    expect(container.querySelectorAll('[data-color-title] > span[style*="background-color"]')).toHaveLength(2);
  });

  it("wraps colour terms onto extra rows instead of scrolling sideways", () => {
    render(<Color colors={colors} selectedColor="1" />);

    const group = screen.getByRole("radiogroup", { name: "انتخاب رنگ محصول" });

    expect(group).toHaveClass("flex-wrap");
    expect(group.className).not.toContain("overflow-x");
  });

  it("marks the picked size with a filled radio and leaves the rest hollow", () => {
    const { container } = render(
      <Size
        sizes={["XL", "L", "M"].map((title, index) => ({ id: String(index), title, variations: [] }))}
        selectedSize="1"
      />,
    );

    const radioOf = (title: string) =>
      container.querySelector<HTMLElement>(`[data-size-title="${title}"] > span:last-child`);

    expect(radioOf("L")?.childElementCount).toBe(1);
    expect(radioOf("XL")?.childElementCount).toBe(0);
    // The marker is decoration; aria-pressed already carries the state.
    expect(radioOf("L")).toHaveAttribute("aria-hidden", "true");
  });

  it("wraps sizes onto extra rows and drops the scroll arrows", () => {
    render(
      <Size
        sizes={["۳XL", "XXL", "XL", "L", "M"].map((title, index) => ({
          id: String(index),
          title,
          variations: [],
        }))}
        selectedSize="3"
      />,
    );

    const group = screen.getByRole("radiogroup", { name: "انتخاب سایز محصول" });

    expect(group).toHaveClass("flex-wrap");
    expect(screen.queryByLabelText("اسکرول به راست")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("اسکرول به چپ")).not.toBeInTheDocument();
  });

  it("renders a Color-typed generic attribute as cards and still reports the picked term", async () => {
    const onChange = jest.fn();
    const selector: GenericAttributeSelector = {
      assignmentId: 1,
      attributeId: 7,
      title: "رنگ و طرح",
      type: "Color",
      position: 0,
      options: [
        { id: "10", title: "ذغالی", colorCode: "#191A24", position: 0 },
        { id: "11", title: "سبز زمردی", colorCode: "#335546", position: 1 },
      ],
    };

    render(
      <GenericAttributes
        selectors={[selector]}
        selection={{ "7": "10" }}
        disabledTermIds={new Set()}
        onChange={onChange}
      />,
    );

    const options = screen.getAllByTestId("pdp-generic-color-option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-pressed", "true");

    await userEvent.click(options[1]);

    expect(onChange).toHaveBeenCalledWith("7", "11");
  });

  it("falls back to name chips for a Color attribute whose terms have no hex", () => {
    const selector: GenericAttributeSelector = {
      assignmentId: 2,
      attributeId: 9,
      title: "طرح",
      type: "Color",
      position: 0,
      options: [
        { id: "20", title: "ساده", colorCode: null, position: 0 },
        { id: "21", title: "راه راه", colorCode: "not-a-hex", position: 1 },
      ],
    };

    render(
      <GenericAttributes
        selectors={[selector]}
        selection={{ "9": "20" }}
        disabledTermIds={new Set()}
        onChange={jest.fn()}
      />,
    );

    expect(screen.queryByTestId("pdp-generic-color-option")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("pdp-generic-option")).toHaveLength(2);
    // The heading follows the attribute type, so losing the swatches does not restyle it.
    expect(screen.getByRole("heading", { name: "طرح" })).toHaveClass("text-xl");
  });

  it("keeps out-of-stock colour terms unclickable", async () => {
    const onColorChange = jest.fn();
    render(<Color colors={colors} selectedColor="1" disabledColorIds={["2"]} onColorChange={onColorChange} />);

    const soldOut = screen.getByRole("button", { name: "رنگ قهوه ای ناموجود" });

    expect(soldOut).toBeDisabled();
    await userEvent.click(soldOut);
    expect(onColorChange).not.toHaveBeenCalled();
  });
});
