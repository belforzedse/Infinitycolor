import {
  e2eFixturePhone,
  e2eFixturesAccess,
  e2eFixturesTokenMatches,
  isE2EFixturePhone,
  isValidFixtureSlot,
} from "../e2eFixtures";

const TOKEN = "t".repeat(32);
const STAGING = {
  E2E_FIXTURES_ENABLED: "true",
  E2E_FIXTURES_TOKEN: TOKEN,
  FRONTEND_URL: "https://staging.infinitycolor.co",
  URL: "https://api.staging.infinitycolor.co",
};

const OIDC = {
  E2E_FIXTURES_OIDC_ISSUER: "https://git.alpagency.net",
  E2E_FIXTURES_OIDC_AUDIENCE: "https://api.staging.infinitycolor.co",
  E2E_FIXTURES_OIDC_PROJECT: "bel4/infinity",
  E2E_FIXTURES_OIDC_ENVIRONMENT: "staging",
};

describe("e2e fixture switch", () => {
  it("is on only with the flag and a static token of at least 32 characters or GitLab ID tokens", () => {
    expect(e2eFixturesAccess(STAGING)).toEqual({ staticToken: TOKEN, oidc: null });
    expect(e2eFixturesAccess({ ...STAGING, E2E_FIXTURES_ENABLED: undefined })).toBeNull();
    expect(e2eFixturesAccess({ ...STAGING, E2E_FIXTURES_ENABLED: "1" })).toBeNull();
    expect(e2eFixturesAccess({ ...STAGING, E2E_FIXTURES_TOKEN: "short" })).toBeNull();
    expect(e2eFixturesAccess({ ...STAGING, E2E_FIXTURES_TOKEN: undefined })).toBeNull();
  });

  it("reads the GitLab ID token settings, and needs all four", () => {
    const env = { ...STAGING, E2E_FIXTURES_TOKEN: undefined, ...OIDC };
    expect(e2eFixturesAccess(env)).toEqual({
      staticToken: null,
      oidc: {
        issuer: "https://git.alpagency.net",
        audience: "https://api.staging.infinitycolor.co",
        project: "bel4/infinity",
        environment: "staging",
        refs: [],
      },
    });
    expect(e2eFixturesAccess({ ...env, E2E_FIXTURES_OIDC_REFS: " dev, main ," })?.oidc?.refs).toEqual(["dev", "main"]);
    for (const key of Object.keys(OIDC)) {
      expect(e2eFixturesAccess({ ...env, [key]: undefined })).toBeNull();
    }
    expect(e2eFixturesAccess({ ...env, E2E_FIXTURES_OIDC_ISSUER: "http://git.alpagency.net" })).toBeNull();
  });

  it.each([
    ["FRONTEND_URL", "https://infinitycolor.co"],
    ["FRONTEND_BASE_URL", "https://www.infinitycolor.co/"],
    ["URL", "https://api.infinitycolor.co"],
    ["FRONTEND_URL", "https://infinitygram.co"],
  ])("refuses a backend whose %s is production (%s), even when switched on", (key, value) => {
    expect(e2eFixturesAccess({ ...STAGING, ...OIDC, [key]: value })).toBeNull();
  });

  it("compares tokens by digest", () => {
    expect(e2eFixturesTokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(e2eFixturesTokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(e2eFixturesTokenMatches("", TOKEN)).toBe(false);
    expect(e2eFixturesTokenMatches(undefined, TOKEN)).toBe(false);
    expect(e2eFixturesTokenMatches([TOKEN], TOKEN)).toBe(false);
  });
});

describe("e2e fixture shoppers", () => {
  it("maps each slot to one reserved phone", () => {
    expect(e2eFixturePhone(0)).toBe("+989000003000");
    expect(e2eFixturePhone(63)).toBe("+989000003063");
    expect(() => e2eFixturePhone(64)).toThrow("E2E_FIXTURE_SLOT_INVALID");
    expect(() => e2eFixturePhone(-1)).toThrow("E2E_FIXTURE_SLOT_INVALID");
    expect(isValidFixtureSlot(1.5)).toBe(false);
    expect(isValidFixtureSlot("3")).toBe(false);
  });

  it("recognises the range in any storage format, only where fixtures are enabled", () => {
    const on = { E2E_FIXTURES_ENABLED: "true" };
    for (const phone of ["+989000003007", "09000003007", "989000003007"]) {
      expect(isE2EFixturePhone(phone, on)).toBe(true);
      expect(isE2EFixturePhone(phone, {})).toBe(false);
    }
    expect(isE2EFixturePhone("09123456789", on)).toBe(false);
    expect(isE2EFixturePhone("09000002999", on)).toBe(false);
    expect(isE2EFixturePhone(null, on)).toBe(false);
  });
});
