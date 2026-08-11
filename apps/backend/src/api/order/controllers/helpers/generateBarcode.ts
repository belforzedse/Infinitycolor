import type { Strapi } from "@strapi/strapi";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import {
  AnipoWorkflowError,
  submitAnipoBarcode,
} from "../../services/anipoBarcodeWorkflow";

function workflowError(ctx: any, error: unknown) {
  const known = error instanceof AnipoWorkflowError;
  const status = known ? error.status : 500;
  const message = known ? error.message : "صدور بارکد آنیپو ناموفق بود";
  ctx.status = status;
  ctx.body = {
    success: false,
    errorCode: known ? error.code : "GENERATE_BARCODE_FAILED",
    message,
  };
}

export async function generateAnipoBarcodeHandler(strapi: Strapi, ctx: any) {
  const orderId = Number(ctx.params?.id);
  const { weight, boxSizeId } = ctx.request?.body || {};
  try {
    const actorId = Number(ctx.state?.user?.id || 0);
    const result = await submitAnipoBarcode(strapi, orderId, {
      weight,
      boxSizeId,
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
    strapi.log.error("Anipo barcode submission failed", {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    });
    workflowError(ctx, error);
  }
}
