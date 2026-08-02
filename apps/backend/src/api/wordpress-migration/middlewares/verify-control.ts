import { isTrustedWordPressMigrationRequest } from "../../../utils/migration-context";

export default () => async (ctx: any, next: () => Promise<void>) => {
  if (!isTrustedWordPressMigrationRequest()) {
    ctx.status = 404;
    ctx.body = { error: "NOT_FOUND" };
    return;
  }
  await next();
};
