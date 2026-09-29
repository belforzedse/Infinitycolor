import {
  E2E_FIXTURES_ID_TOKEN_HEADER,
  E2E_FIXTURES_TOKEN_HEADER,
  e2eFixturesAccess,
  e2eFixturesTokenMatches,
  type E2EFixturesAccess,
} from "../../../utils/e2eFixtures";
import { verifyE2EFixturesIdToken } from "../../../utils/e2eFixturesIdToken";

async function admitted(ctx, access: E2EFixturesAccess, log?: { warn: (message: string) => void }) {
  const headers = ctx.request.headers;
  if (access.staticToken && e2eFixturesTokenMatches(headers[E2E_FIXTURES_TOKEN_HEADER], access.staticToken)) {
    return true;
  }
  const idToken = headers[E2E_FIXTURES_ID_TOKEN_HEADER];
  if (access.oidc && typeof idToken === "string" && idToken) {
    const verdict = await verifyE2EFixturesIdToken(idToken, access.oidc);
    if (!("reason" in verdict)) return true;
    // The caller only ever sees a 404; this is how a claim mismatch is found.
    log?.warn(`[e2e-fixture] refused a GitLab ID token: ${verdict.reason}`);
  }
  return false;
}

/**
 * 404 — not 401 — for every refusal, so an environment without fixtures (and a
 * caller that cannot prove itself) cannot tell the routes exist.
 */
export default (_config?: unknown, { strapi }: { strapi?: any } = {}) =>
  async (ctx, next) => {
    const access = e2eFixturesAccess();
    if (!access || !(await admitted(ctx, access, strapi?.log))) {
      ctx.status = 404;
      ctx.body = { data: null, error: { status: 404, name: "NotFoundError", message: "Not Found" } };
      return;
    }
    await next();
  };
