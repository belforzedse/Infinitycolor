import { render } from "@testing-library/react";
import { SOCIAL_PLATFORM_META, SocialPlatformIcon } from "../identityIcons";

describe("Bale social mark", () => {
  it("uses the official Bale SVG instead of the generic placeholder", () => {
    const bale = SOCIAL_PLATFORM_META.bale;
    expect(bale.hasPlaceholderIcon).toBeFalsy();
    expect(bale.iconSrc).toBe("/images/social/bale.svg");
    expect(bale.Icon).toBeDefined();
    expect(bale.color).toBe("#00B894");
  });

  it("renders the Bale mark as an inline SVG", () => {
    const { container } = render(<SocialPlatformIcon platform="bale" size={16} />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg).toHaveAttribute("viewBox", "0 0 32 32");
    expect(container.querySelector("img")).toBeNull();
  });
});
