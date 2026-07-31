import { render, screen } from "@testing-library/react";
import FactorchiBarcode, { encodeFactorchiCode128B } from "../FactorchiBarcode";

describe("FactorchiBarcode", () => {
  it("matches Factorchi's Code 128B sequence and two-pixel module geometry", () => {
    const barcode = encodeFactorchiCode128B("42");

    expect(barcode).not.toBeNull();
    expect(barcode).toMatchObject({
      height: 60,
      value: "42",
      width: 114,
    });
    expect(barcode?.bars[0]).toEqual({ x: 0, width: 4 });
    expect(barcode?.bars.at(-1)).toEqual({ x: 110, width: 4 });
  });

  it("drops unsupported characters like Factorchi and renders the human-readable value as metadata", () => {
    render(<FactorchiBarcode value={" 42\u06f1 "} />);

    expect(screen.getByTestId("invoice-barcode")).toHaveAttribute("data-value", "42");
    expect(screen.getByRole("img", { name: "42" })).toHaveAttribute("width", "114");
  });
});
