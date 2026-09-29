import { createHash, timingSafeEqual } from "node:crypto";
import { canonicalCustomerPhone } from "./customerPhoneIdentity";

/**
 * Staging E2E fixtures: the switch, who may call the fixture API, and the
 * reserved shopper phone range, shared by the fixture API (api/e2e-fixture) and
 * the SMS senders.
 *
 * The fixture API only exists where an environment opts in with
 * `E2E_FIXTURES_ENABLED=true` (staging's stack.yml) and says how callers prove
 * who they are: GitLab CI ID tokens (the `E2E_FIXTURES_OIDC_*` settings, how
 * the staging E2E jobs call it) and/or a static token of at least 32 characters
 * (`E2E_FIXTURES_TOKEN`, for runs from a laptop). Production sets none of this,
 * and a backend whose storefront or public URL is a production origin refuses
 * even if it were set by mistake.
 */

export const E2E_FIXTURES_TOKEN_HEADER = "x-e2e-fixtures-token";
export const E2E_FIXTURES_ID_TOKEN_HEADER = "x-e2e-fixtures-id-token";
export const E2E_FIXTURE_SOURCE = "e2e-fixture";
export const E2E_FIXTURE_MAX_SLOT = 63;
/** Marks accounts the fixture API created; it never adopts any other account. */
export const E2E_FIXTURE_EMAIL_DOMAIN = "e2e-fixture.invalid";

// Fixture shoppers are +98 900 000 3000 + slot. They are synthetic: nothing may
// text them, so SMS senders skip this range wherever fixtures are enabled.
const FIXTURE_PHONE_BASE = 3_000;
const FIXTURE_PHONE_PATTERN = /^\+98900000(3\d{3})$/;

const PRODUCTION_HOSTS = new Set([
  "infinitycolor.co",
  "www.infinitycolor.co",
  "new.infinitycolor.co",
  "api.infinitycolor.co",
  "infinitygram.co",
  "www.infinitygram.co",
]);

type Env = Record<string, string | undefined>;

function hostOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True where the environment has opted in; enough on its own to silence SMS. */
export function isE2EFixturesFlagOn(env: Env = process.env): boolean {
  return env.E2E_FIXTURES_ENABLED === "true";
}

function pointsAtProduction(env: Env): boolean {
  return [env.FRONTEND_URL, env.FRONTEND_BASE_URL, env.URL].some((value) => {
    const host = hostOf(value);
    return host !== null && PRODUCTION_HOSTS.has(host);
  });
}

/** What a GitLab CI ID token must say to be let in. */
export interface E2EFixturesOidcConfig {
  /** The GitLab instance, e.g. https://git.alpagency.net (the token's `iss`). */
  issuer: string;
  /** The `aud` the job asked for in its `id_tokens:` block. */
  audience: string;
  /** `project_path` claim, e.g. bel4/infinity. */
  project: string;
  /** `environment` claim: the job's `environment:` name. */
  environment: string;
  /** Allowed `ref` claims; empty allows any protected ref. */
  refs: string[];
}

export interface E2EFixturesAccess {
  staticToken: string | null;
  oidc: E2EFixturesOidcConfig | null;
}

function httpsOrigin(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

function oidcConfig(env: Env): E2EFixturesOidcConfig | null {
  const issuer = httpsOrigin(env.E2E_FIXTURES_OIDC_ISSUER);
  const audience = env.E2E_FIXTURES_OIDC_AUDIENCE?.trim();
  const project = env.E2E_FIXTURES_OIDC_PROJECT?.trim();
  const environment = env.E2E_FIXTURES_OIDC_ENVIRONMENT?.trim();
  if (!issuer || !audience || !project || !environment) return null;
  const refs = (env.E2E_FIXTURES_OIDC_REFS ?? "")
    .split(",")
    .map((ref) => ref.trim())
    .filter(Boolean);
  return { issuer, audience, project, environment, refs };
}

/** How callers may prove themselves, or null when the API must answer 404. */
export function e2eFixturesAccess(env: Env = process.env): E2EFixturesAccess | null {
  if (!isE2EFixturesFlagOn(env) || pointsAtProduction(env)) return null;
  const token = env.E2E_FIXTURES_TOKEN?.trim();
  const staticToken = token && token.length >= 32 ? token : null;
  const oidc = oidcConfig(env);
  if (!staticToken && !oidc) return null;
  return { staticToken, oidc };
}

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();

/** Constant-time comparison of equal-length digests, whatever the inputs. */
export function e2eFixturesTokenMatches(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || !supplied) return false;
  return timingSafeEqual(digest(supplied), digest(expected));
}

export function isValidFixtureSlot(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= E2E_FIXTURE_MAX_SLOT;
}

/** Canonical `+98…` phone of a slot's shopper. */
export function e2eFixturePhone(slot: number): string {
  if (!isValidFixtureSlot(slot)) throw new Error("E2E_FIXTURE_SLOT_INVALID");
  return `+98900000${FIXTURE_PHONE_BASE + slot}`;
}

/** A phone in the reserved range, on an environment with fixtures switched on. */
export function isE2EFixturePhone(phone: unknown, env: Env = process.env): boolean {
  if (!isE2EFixturesFlagOn(env)) return false;
  const canonical = canonicalCustomerPhone(phone);
  return Boolean(canonical && FIXTURE_PHONE_PATTERN.test(canonical));
}
