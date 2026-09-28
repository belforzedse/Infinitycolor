import {
  E2E_FIXTURES_TOKEN_HEADER,
  e2eFixturesToken,
  e2eFixturesTokenMatches,
} from "../../../utils/e2eFixtures";

/**
 * 404 — not 401 — for every refusal, so an environment without fixtures (and a
 * caller without the token) cannot tell the routes exist.
 */
export default () => async (ctx, next) => {
  const expected = e2eFixturesToken();
  if (!expected || !e2eFixturesTokenMatches(ctx.request.headers[E2E_FIXTURES_TOKEN_HEADER], expected)) {
    ctx.status = 404;
    ctx.body = { data: null, error: { status: 404, name: "NotFoundError", message: "Not Found" } };
    return;
  }
  await next();
};
