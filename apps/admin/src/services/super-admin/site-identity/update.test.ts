jest.mock("@/services", () => ({
  apiClient: { get: jest.fn(), put: jest.fn() },
}));

import { apiClient } from "@/services";
import { DEFAULT_SITE_IDENTITY } from "@/services/site-identity";
import type { SiteIdentity } from "@/types/site-identity";
import {
  SOCIAL_LINK_URL_REQUIRED_MESSAGE,
  buildSiteIdentityWritePayload,
  updateSuperAdminSiteIdentity,
} from "./update";

const mockGet = apiClient.get as jest.Mock;
const mockPut = apiClient.put as jest.Mock;

const identity: SiteIdentity = {
  siteName: "فروشگاه تست",
  hasPhysicalStores: true,
  hasMultipleStores: false,
  stores: [],
  socialLinks: [
    { id: 4, platform: "instagram", url: "https://instagram.com/existing", label: "قدیمی" },
    { platform: "telegram", url: "https://t.me/new-shop", label: "جدید" },
  ],
  contactNumbers: [],
};

describe("buildSiteIdentityWritePayload", () => {
  it("keeps existing social component ids and sends new rows without ids", () => {
    expect(buildSiteIdentityWritePayload(identity).socialLinks).toEqual([
      {
        id: 4,
        platform: "instagram",
        url: "https://instagram.com/existing",
        label: "قدیمی",
      },
      {
        platform: "telegram",
        url: "https://t.me/new-shop",
        label: "جدید",
      },
    ]);
  });

  it("rejects a social row that has a platform but no URL", () => {
    expect(() =>
      buildSiteIdentityWritePayload({
        ...identity,
        socialLinks: [{ platform: "bale", url: "", label: "" }],
      }),
    ).toThrow(SOCIAL_LINK_URL_REQUIRED_MESSAGE);
  });
});

describe("updateSuperAdminSiteIdentity", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockPut.mockReset();
  });

  it("does not replace saved social links with defaults when PUT omits attributes", async () => {
    mockPut.mockResolvedValue({ data: { id: 1 } });
    mockGet.mockResolvedValue({
      data: {
        id: 1,
        attributes: {
          siteName: "فروشگاه تست",
          socialLinks: [
            { id: 4, platform: "instagram", url: "https://instagram.com/existing", label: "قدیمی" },
            { id: 9, platform: "telegram", url: "https://t.me/new-shop", label: "جدید" },
          ],
          stores: [],
          contactNumbers: [],
        },
      },
    });

    const saved = await updateSuperAdminSiteIdentity(identity);

    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(saved.socialLinks).toEqual([
      { id: 4, platform: "instagram", url: "https://instagram.com/existing", label: "قدیمی" },
      { id: 9, platform: "telegram", url: "https://t.me/new-shop", label: "جدید" },
    ]);
    expect(saved.socialLinks).not.toEqual(DEFAULT_SITE_IDENTITY.socialLinks);
  });
});
