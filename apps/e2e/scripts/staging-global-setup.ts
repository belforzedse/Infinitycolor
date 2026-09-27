import { stagingTargets } from "../fixtures/staging";
import { assertSafeTargets } from "../helpers/target-guard.mjs";

/**
 * Refuse any target that is not staging (or an explicitly allowed disposable
 * stack), then prove the fixture API answers before a single browser starts,
 * so a missing token or a disabled API fails in seconds with the fix named.
 */
export default async function stagingGlobalSetup() {
  const targets = stagingTargets();
  assertSafeTargets(targets, { allowHosts: process.env.E2E_ALLOW_TARGET_HOSTS });

  const token = process.env.E2E_FIXTURES_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "E2E_FIXTURES_TOKEN is not set. Run deploy/infinity-staging/enable-e2e-fixtures.sh on the staging " +
        "host and add the printed token as the GitLab variable E2E_FIXTURES_TOKEN (environment scope: staging).",
    );
  }
  // An unprovisioned slot answers E2E_FIXTURE_SLOT_UNPROVISIONED; a bare 404
  // means the API is off or the token does not match.
  const probe = await fetch(`${targets.api}/e2e-fixtures/shoppers/63/stock`, {
    headers: { Accept: "application/json", "x-e2e-fixtures-token": token },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await probe.text();
  if (!probe.ok && !body.includes("E2E_FIXTURE")) {
    throw new Error(
      `The fixture API at ${targets.api} is unavailable (${probe.status}). Either this backend does not have ` +
        "E2E_FIXTURES_ENABLED=true and a token, or E2E_FIXTURES_TOKEN does not match it.",
    );
  }
}
