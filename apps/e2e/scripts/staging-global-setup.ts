import { FIXTURE_SETUP_HINT, fixtureCredential, fixtureRefusedMessage, stagingTargets } from "../fixtures/staging";
import { assertSafeTargets } from "../helpers/target-guard.mjs";

// Long enough for the slowest job (the nightly full run); the token lives as
// long as the job's timeout.
const MIN_ID_TOKEN_LIFETIME_S = 10 * 60;

// Claims the backend checks, and the ones that explain a mismatch. Printing
// them is safe: they identify the job, they do not authenticate anything.
const PRINTED_CLAIMS = [
  "iss",
  "aud",
  "project_path",
  "ref",
  "ref_protected",
  "environment",
  "environment_action",
  "pipeline_source",
] as const;

/** Decoded, not verified: only the backend's verification counts. */
function describeIdToken(token: string) {
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    throw new Error("E2E_FIXTURES_ID_TOKEN is not a JWT; check the job's id_tokens block.");
  }
  const lifetime = Number(claims.exp) - Math.floor(Date.now() / 1000);
  const shown = PRINTED_CLAIMS.map((claim) => `${claim}=${JSON.stringify(claims[claim])}`).join(" ");
  console.log(`[staging-e2e] GitLab ID token: ${shown} expires_in=${lifetime}s`);
  if (!Number.isFinite(lifetime) || lifetime < MIN_ID_TOKEN_LIFETIME_S) {
    throw new Error(
      `The GitLab ID token expires in ${lifetime}s, too soon for this run; raise the job's timeout ` +
        "(it sets the token's lifetime).",
    );
  }
}

/**
 * Refuse any target that is not staging (or an explicitly allowed disposable
 * stack), then prove the fixture API lets this run in before a single browser
 * starts, so a missing or refused credential fails in seconds with the fix named.
 */
export default async function stagingGlobalSetup() {
  const targets = stagingTargets();
  assertSafeTargets(targets, { allowHosts: process.env.E2E_ALLOW_TARGET_HOSTS });

  const credential = fixtureCredential();
  if (!credential) throw new Error(`No fixture API credential. ${FIXTURE_SETUP_HINT}`);
  if (credential.kind === "GitLab ID token") describeIdToken(credential.value);

  // An unprovisioned slot answers E2E_FIXTURE_SLOT_UNPROVISIONED; a bare 404
  // means the API is off or refused the credential.
  const probe = await fetch(`${targets.api}/e2e-fixtures/shoppers/63/stock`, {
    headers: { Accept: "application/json", [credential.header]: credential.value },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await probe.text();
  if (!probe.ok && !body.includes("E2E_FIXTURE")) {
    throw new Error(fixtureRefusedMessage(targets.api, probe.status));
  }
  console.log(`[staging-e2e] the fixture API at ${targets.api} accepts this run's ${credential.kind}`);
}
