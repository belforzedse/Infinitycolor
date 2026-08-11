import type { Strapi } from "@strapi/strapi";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import {
  AnipoWorkflowError,
  refreshAnipoBarcodeStatus,
} from "../../services/anipoBarcodeWorkflow";

export async function checkAnipoBarcodeHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  try {
    const actorId = Number(ctx.state?.user?.id || 0);
    const result = await refreshAnipoBarcodeStatus(strapi, orderId, {
      source: "admin",
      actor: actorId > 0
        ? {
            id: actorId,
            ip: getClientIp(ctx),
            userAgent: getUserAgent(ctx),
            roleName: ctx.state?.user?.role?.name,
          }
        : undefined,
    });
    ctx.status = result.pending ? 202 : 200;
    ctx.body = result;
  } catch (error) {
    const known = error instanceof AnipoWorkflowError;
    strapi.log.error("Anipo barcode status check failed", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    ctx.status = known ? error.status : 500;
    ctx.body = {
      success: false,
      errorCode: known ? error.code : "ANIPO_STATUS_CHECK_FAILED",
      message: known ? error.message : "دریافت وضعیت بارکد از آنیپو ناموفق بود",
    };
  }
}
