import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import type { E2EFixturesOidcConfig } from "./e2eFixtures";

/**
 * GitLab CI ID tokens for the fixture API. A job that declares
 * `id_tokens: { E2E_FIXTURES_ID_TOKEN: { aud: … } }` gets a short-lived RS256
 * JWT signed by the GitLab instance; we check it against the instance's
 * published keys and require the project, a protected ref and the environment
 * the job declared. No shared secret exists anywhere.
 * https://docs.gitlab.com/ci/secrets/id_token_authentication/
 */

const JWKS_TIMEOUT_MS = 5_000;
const CLOCK_TOLERANCE_SECONDS = 5;

let remote: { url: string; jwks: JWTVerifyGetKey } | undefined;

function remoteJwks(issuer: string): JWTVerifyGetKey {
  const url = new URL("/oauth/discovery/keys", issuer).href;
  if (remote?.url !== url) {
    remote = {
      url,
      jwks: createRemoteJWKSet(new URL(url), {
        timeoutDuration: JWKS_TIMEOUT_MS,
        cooldownDuration: 30_000,
        cacheMaxAge: 10 * 60_000,
        headers: { accept: "application/json" },
      }),
    };
  }
  return remote.jwks;
}

export type IdTokenVerdict = { ok: true; job: string } | { ok: false; reason: string };

/** Never throws; a refusal names the check that failed, never the token. */
export async function verifyE2EFixturesIdToken(
  token: unknown,
  config: E2EFixturesOidcConfig,
  jwks: JWTVerifyGetKey = remoteJwks(config.issuer),
): Promise<IdTokenVerdict> {
  if (typeof token !== "string" || !token) return { ok: false, reason: "missing" };

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.audience,
      algorithms: ["RS256"],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    }));
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : "invalid";
    return { ok: false, reason: `jwt ${code}` };
  }

  // GitLab sends these as strings ("true", not true).
  if (claims.project_path !== config.project) return { ok: false, reason: "project_path" };
  if (claims.ref_protected !== "true") return { ok: false, reason: "ref_protected" };
  if (claims.environment !== config.environment) return { ok: false, reason: "environment" };
  if (config.refs.length > 0 && !config.refs.includes(String(claims.ref))) return { ok: false, reason: "ref" };
  return { ok: true, job: String(claims.job_id ?? "") };
}
