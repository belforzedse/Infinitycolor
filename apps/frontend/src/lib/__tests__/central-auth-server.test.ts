import {
  isTrustedStorefrontRequest,
  storefrontOrigin,
  storefrontUrl,
} from "@/lib/central-auth-server";

describe("central auth storefront authority", () => {
  it("builds callback redirects from the configured storefront origin", () => {
    const target = storefrontUrl("/auth/complete?error=invalid_grant");

    expect(target.origin).toBe(storefrontOrigin());
    expect(target.pathname).toBe("/auth/complete");
    expect(target.searchParams.get("error")).toBe("invalid_grant");
    expect(target.origin).not.toBe("https://0.0.0.0:3000");
  });

  it("accepts only the configured storefront Origin for route-hint mutations", () => {
    expect(isTrustedStorefrontRequest(storefrontOrigin(), "same-origin")).toBe(true);
    expect(isTrustedStorefrontRequest(null, "same-origin")).toBe(true);
    expect(isTrustedStorefrontRequest("https://0.0.0.0:3000", "same-origin")).toBe(false);
    expect(isTrustedStorefrontRequest(storefrontOrigin(), "cross-site")).toBe(false);
  });
});
