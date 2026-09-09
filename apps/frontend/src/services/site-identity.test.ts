import { normalizeSiteIdentity } from "./site-identity";

describe("normalizeSiteIdentity", () => {
  it("preserves the store postal code used by invoice printouts", () => {
    const identity = normalizeSiteIdentity({
      siteName: "مجموعه فروشگاه پوشاک",
      stores: [
        {
          name: "گرگان",
          address: "گرگان، بلوار ناهارخوران",
          postalCode: "4916976618",
          phones: [],
          socialLinks: [],
        },
      ],
      socialLinks: [],
      contactNumbers: [],
    });

    expect(identity.stores[0]).toMatchObject({
      name: "گرگان",
      address: "گرگان، بلوار ناهارخوران",
      postalCode: "4916976618",
    });
  });

  it("keeps Telegram links on global and store contact surfaces", () => {
    const identity = normalizeSiteIdentity({
      siteName: "فروشگاه اینفینیتی",
      stores: [
        {
          name: "گرگان",
          phones: [],
          socialLinks: [
            { platform: "telegram", url: "https://t.me/old-store" },
            { platform: "instagram", url: "https://instagram.com/store" },
          ],
        },
      ],
      socialLinks: [
        { platform: "telegram", url: "https://t.me/old-global" },
        { platform: "instagram", url: "https://instagram.com/global" },
      ],
      contactNumbers: [],
    });

    expect(identity.socialLinks).toEqual([
      { platform: "telegram", url: "https://t.me/old-global", label: undefined },
      { platform: "instagram", url: "https://instagram.com/global", label: undefined },
    ]);
    expect(identity.stores[0]?.socialLinks).toEqual([
      { platform: "telegram", url: "https://t.me/old-store", label: undefined },
      { platform: "instagram", url: "https://instagram.com/store", label: undefined },
    ]);
  });

  it("keeps social links wrapped in Strapi component attributes", () => {
    const identity = normalizeSiteIdentity({
      siteName: "فروشگاه اینفینیتی",
      stores: [],
      socialLinks: [
        {
          id: 12,
          attributes: {
            platform: "bale",
            url: "https://ble.ir/infinity",
            label: "بله",
          },
        },
      ],
      contactNumbers: [],
    });

    expect(identity.socialLinks).toEqual([
      { id: 12, platform: "bale", url: "https://ble.ir/infinity", label: "بله" },
    ]);
  });

  it("restores گنبد کاووس when the store title contains replacement characters", () => {
    const identity = normalizeSiteIdentity({
      siteName: "فروشگاه اینفینیتی",
      stores: [
        {
          name: `گنبد ک\uFFFD\uFFFDووس`,
          address: "گنبد کاووس، ابتدای بلوار دانشجو",
          phones: [],
          socialLinks: [],
        },
      ],
      socialLinks: [],
      contactNumbers: [],
    });

    expect(identity.stores[0]?.name).toBe("گنبد کاووس");
  });
});
