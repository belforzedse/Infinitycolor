import {
  DEFAULT_SITE_IDENTITY,
  normalizeSiteIdentity,
  readSiteIdentityFromApi,
  repairStoreDisplayName,
} from "../site-identity";

describe("normalizeSiteIdentity", () => {
  it("keeps Telegram and other CMS social links", () => {
    const identity = normalizeSiteIdentity({
      siteName: "فروشگاه اینفینیتی",
      socialLinks: [
        { id: 3, platform: "telegram", url: "https://t.me/shop", label: "تلگرام" },
        { platform: "instagram", url: "https://instagram.com/shop" },
      ],
      stores: [],
      contactNumbers: [],
    });

    expect(identity.socialLinks).toEqual([
      { id: 3, platform: "telegram", url: "https://t.me/shop", label: "تلگرام" },
      { platform: "instagram", url: "https://instagram.com/shop", label: undefined },
    ]);
  });

  it("unwraps social links stored as Strapi component entities", () => {
    const identity = normalizeSiteIdentity({
      siteName: "فروشگاه اینفینیتی",
      socialLinks: [
        {
          id: 8,
          attributes: {
            platform: "eitaa",
            url: "https://eitaa.com/infinity",
            label: "ایتا",
          },
        },
      ],
      stores: [],
      contactNumbers: [],
    });

    expect(identity.socialLinks).toEqual([
      { id: 8, platform: "eitaa", url: "https://eitaa.com/infinity", label: "ایتا" },
    ]);
  });
});

describe("readSiteIdentityFromApi", () => {
  it("reads classic REST attributes", () => {
    const identity = readSiteIdentityFromApi({
      data: {
        id: 1,
        attributes: {
          siteName: "هویت سفارشی",
          socialLinks: [{ platform: "bale", url: "https://ble.ir/shop", label: "بله" }],
          stores: [],
          contactNumbers: [],
        },
      },
    });

    expect(identity.siteName).toBe("هویت سفارشی");
    expect(identity.socialLinks).toEqual([
      { platform: "bale", url: "https://ble.ir/shop", label: "بله" },
    ]);
  });

  it("reads flattened payloads without an attributes wrapper", () => {
    const identity = readSiteIdentityFromApi({
      data: {
        id: 1,
        siteName: "هویت تخت",
        socialLinks: [{ platform: "x", url: "https://x.com/shop" }],
        stores: [],
        contactNumbers: [],
      },
    });

    expect(identity.siteName).toBe("هویت تخت");
    expect(identity.socialLinks).toEqual([
      { platform: "x", url: "https://x.com/shop", label: undefined },
    ]);
  });

  it("falls back when the payload is empty", () => {
    expect(readSiteIdentityFromApi(undefined).siteName).toBe(DEFAULT_SITE_IDENTITY.siteName);
  });
});

describe("repairStoreDisplayName", () => {
  it("restores گنبد کاووس when replacement characters broke the title", () => {
    expect(repairStoreDisplayName(`گنبد ک\uFFFD\uFFFDووس`)).toBe("گنبد کاووس");
    expect(repairStoreDisplayName("گنبدکاووس")).toBe("گنبد کاووس");
    expect(repairStoreDisplayName("گرگان")).toBe("گرگان");
  });
});
