import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey, type KeyLike } from "jose";
import type { E2EFixturesOidcConfig } from "../e2eFixtures";
import { verifyE2EFixturesIdToken } from "../e2eFixturesIdToken";

const CONFIG: E2EFixturesOidcConfig = {
  issuer: "https://git.alpagency.net",
  audience: "https://api.staging.infinitycolor.co",
  project: "bel4/infinity",
  environment: "staging",
  refs: [],
};

// What GitLab puts in a staging E2E job's token (the claims we check).
const CLAIMS = {
  project_path: "bel4/infinity",
  ref: "dev",
  ref_type: "branch",
  ref_protected: "true",
  environment: "staging",
  environment_action: "verify",
  pipeline_source: "parent_pipeline",
  job_id: "8461",
};

let privateKey: KeyLike;
let jwks: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: "gitlab", alg: "RS256" }] });
});

function sign(claims: Record<string, unknown> = CLAIMS, options: { iss?: string; aud?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "gitlab" })
    .setIssuer(options.iss ?? CONFIG.issuer)
    .setAudience(options.aud ?? CONFIG.audience)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "30m")
    .sign(privateKey);
}

describe("GitLab ID tokens for the fixture API", () => {
  it("lets in a staging E2E job of this project on a protected ref", async () => {
    await expect(verifyE2EFixturesIdToken(await sign(), CONFIG, jwks)).resolves.toEqual({ ok: true, job: "8461" });
  });

  it.each([
    ["another project", { ...CLAIMS, project_path: "someone/else" }, "project_path"],
    ["an unprotected branch", { ...CLAIMS, ref_protected: "false" }, "ref_protected"],
    ["a boolean ref_protected", { ...CLAIMS, ref_protected: true }, "ref_protected"],
    ["another environment", { ...CLAIMS, environment: "production" }, "environment"],
    ["a job with no environment", { ...CLAIMS, environment: undefined }, "environment"],
  ])("refuses %s", async (_label, claims, reason) => {
    await expect(verifyE2EFixturesIdToken(await sign(claims), CONFIG, jwks)).resolves.toEqual({ ok: false, reason });
  });

  it("refuses a ref outside the allow-list when one is configured", async () => {
    const onlyDev = { ...CONFIG, refs: ["dev"] };
    await expect(verifyE2EFixturesIdToken(await sign(), onlyDev, jwks)).resolves.toEqual({ ok: true, job: "8461" });
    await expect(
      verifyE2EFixturesIdToken(await sign({ ...CLAIMS, ref: "main" }), onlyDev, jwks),
    ).resolves.toEqual({ ok: false, reason: "ref" });
  });

  it.each([
    ["another issuer", { iss: "https://gitlab.com" }],
    ["another audience", { aud: "https://api.infinitycolor.co" }],
    ["an expired token", { exp: "-1m" }],
  ])("refuses %s", async (_label, options) => {
    const verdict = await verifyE2EFixturesIdToken(await sign(CLAIMS, options), CONFIG, jwks);
    expect(verdict.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toMatch(/^jwt /);
  });

  it("refuses a token signed by another key, an HMAC token and garbage", async () => {
    const other = await generateKeyPair("RS256");
    const foreign = await new SignJWT(CLAIMS)
      .setProtectedHeader({ alg: "RS256", kid: "gitlab" })
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setExpirationTime("30m")
      .sign(other.privateKey);
    const hmac = await new SignJWT(CLAIMS)
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(CONFIG.issuer)
      .setAudience(CONFIG.audience)
      .setExpirationTime("30m")
      .sign(new TextEncoder().encode("k".repeat(32)));
    for (const token of [foreign, hmac, "not.a.jwt", "", undefined, ["x"]]) {
      expect((await verifyE2EFixturesIdToken(token, CONFIG, jwks)).ok).toBe(false);
    }
  });
});
