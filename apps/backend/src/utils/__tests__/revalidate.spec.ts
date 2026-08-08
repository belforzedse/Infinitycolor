/**
 * The storefront origins Strapi notifies must come from configuration only.
 *
 * These previously included `https://staging.infinitycolor.co` and
 * `https://infinitycolor.co` as unconditional literals, so production Strapi
 * POSTed an authenticated revalidation to staging on every product/blog/settings
 * write, and staging POSTed to production. Each environment must invalidate its
 * own storefront and nothing else.
 */

import { getFrontendUrls } from "../revalidate";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function withEnv(env: Record<string, string | undefined>) {
  delete process.env.NEXTJS_REVALIDATION_URL;
  delete process.env.FRONTEND_URL;
  Object.assign(process.env, env);
}

describe("getFrontendUrls", () => {
  it("returns the configured storefront origin", () => {
    withEnv({ NEXTJS_REVALIDATION_URL: "https://new.infinitycolor.co" });
    expect(getFrontendUrls()).toEqual(["https://new.infinitycolor.co"]);
  });

  it("supports a comma-separated list and trims surrounding whitespace", () => {
    withEnv({ NEXTJS_REVALIDATION_URL: "https://a.example , https://b.example" });
    expect(getFrontendUrls()).toEqual(["https://a.example", "https://b.example"]);
  });

  it("falls back to FRONTEND_URL when the dedicated variable is unset", () => {
    withEnv({ FRONTEND_URL: "https://new.infinitycolor.co" });
    expect(getFrontendUrls()).toEqual(["https://new.infinitycolor.co"]);
  });

  it("returns nothing when unconfigured rather than guessing an origin", () => {
    withEnv({});
    expect(getFrontendUrls()).toEqual([]);
  });

  it("never injects a hardcoded cross-environment origin", () => {
    withEnv({ NEXTJS_REVALIDATION_URL: "https://new.infinitycolor.co" });
    const urls = getFrontendUrls();
    expect(urls).not.toContain("https://staging.infinitycolor.co");
    expect(urls).not.toContain("https://infinitycolor.co");
    expect(urls).toHaveLength(1);
  });
});
