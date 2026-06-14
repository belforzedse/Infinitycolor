import type { Context } from "koa";
import {
  getAuditContext,
  runWithAuditContext,
  createAuditContext,
  type AuditContext,
} from "../utils/audit-context";
import { getClientIp, getUserAgent } from "../utils/getClientIp";

export default (config: any, { strapi }: any) => {
  return async (ctx: Context, next: any) => {
    // Check if already in an audit context (avoid nesting)
    if (getAuditContext()) {
      return next();
    }

    // Extract user from request state (set by other middlewares)
    let user = ctx.state.user;
    let isAdmin = false;

    // If no user in state, try to get admin user from Strapi context
    if (!user && ctx.request.headers.authorization) {
      try {
        // For admin requests, Strapi's built-in middleware should have set the user
        // If not, we can try to extract from JWT or other sources
        // This is a fallback for admin panel requests
        const adminUser = (ctx as any).admin?.user;
        if (adminUser) {
          user = adminUser;
          isAdmin = true;
        }
      } catch (e) {
        // Silently ignore auth extraction errors
      }
    } else if (user?.id && !user?.Phone && !user?.user_role) {
      // If user has id but no Phone/user_role, it's likely a Strapi admin user
      isAdmin = true;
    }

    // Extract the real client IP + User-Agent via the centralized, proxy-aware helper.
    const ip = getClientIp(ctx);
    const userAgent = getUserAgent(ctx);

    // Create audit context
    const auditContext: AuditContext = {
      ...createAuditContext(user, isAdmin),
      ip,
      userAgent,
    };

    // Run next middleware/handler within audit context
    await runWithAuditContext(auditContext, () => next());
  };
};
