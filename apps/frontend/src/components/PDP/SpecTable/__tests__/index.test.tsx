import { render, screen } from "@testing-library/react";
import SpecTable from "..";

it("displays empty measurements as dashes after normalizing a saved guide", () => {
  render(
    <SpecTable
      specs={[
        ["سایز", "قد", "دور سینه"],
        ["M", "50", ""],
        ["L", null, "   "],
      ]}
    />,
  );

  expect(screen.getAllByRole("cell").map((cell) => cell.textContent)).toEqual([
    "M",
    "50",
    "-",
    "L",
    "-",
    "-",
  ]);
});
