import { normalizeSiteGifImageUrl } from "../site-gif";

describe("normalizeSiteGifImageUrl", () => {
  it("rewrites Strapi responsive GIF derivatives to the original GIF URL", () => {
    expect(normalizeSiteGifImageUrl("/uploads/large_0613_1_388e1f079a.gif")).toBe(
      "/uploads/0613_1_388e1f079a.gif",
    );
    expect(
      normalizeSiteGifImageUrl(
        "https://api.infinitycolor.co/uploads/thumbnail_campaign_abc.gif?updated=1",
      ),
    ).toBe("https://api.infinitycolor.co/uploads/campaign_abc.gif?updated=1");
  });

  it("leaves non-GIF and original GIF URLs unchanged", () => {
    expect(normalizeSiteGifImageUrl("/uploads/large_banner.webp")).toBe(
      "/uploads/large_banner.webp",
    );
    expect(normalizeSiteGifImageUrl("/uploads/campaign.gif")).toBe("/uploads/campaign.gif");
  });
});
