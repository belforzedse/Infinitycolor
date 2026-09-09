import { render } from "@testing-library/react";
import BasketIcon from "../BasketIcon";
import CategoryIcon from "../CategoryIcon";
import ProfileIcon from "../ProfileIcon";
import SearchIcon from "../SearchIcon";

describe("bottom navigation icons", () => {
  it.each([
    ["profile", ProfileIcon],
    ["basket", BasketIcon],
    ["category", CategoryIcon],
    ["search", SearchIcon],
  ])("keeps the %s icon in a 24px square", (_name, Icon) => {
    const { container } = render(<Icon />);
    const svg = container.querySelector("svg");

    expect(svg).toHaveAttribute("width", "24");
    expect(svg).toHaveAttribute("height", "24");
  });
});
