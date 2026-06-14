import { render } from "@testing-library/react";
import SiteGifBanner from "../SiteGifBanner";

describe("SiteGifBanner", () => {
  it("renders Strapi responsive GIF derivatives with the original GIF URL", () => {
    const { container } = render(
      <SiteGifBanner enabled imageUrl="/uploads/large_0613_1_388e1f079a.gif" />,
    );

    const image = container.querySelector("img");
    expect(image).toHaveAttribute("src", expect.stringContaining("/uploads/0613_1_388e1f079a.gif"));
    expect(image).not.toHaveAttribute(
      "src",
      expect.stringContaining("/uploads/large_0613_1_388e1f079a.gif"),
    );
  });

  it("renders nothing when disabled", () => {
    const { container } = render(<SiteGifBanner enabled={false} imageUrl="/uploads/banner.gif" />);

    expect(container.firstChild).toBeNull();
  });
});
