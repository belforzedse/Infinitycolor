import type { Strapi } from "@strapi/strapi";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { AnipoWorkflowError } from "../../services/anipoBarcodeWorkflow";
import { submitReserveParcel, refreshReserveParcel } from "../../services/anipoReserveParcel";

export async function reserveParcelAnipoHandler(strapi: Strapi, ctx: any, check = false) {
  const key = String(ctx.params?.groupKey || "").trim();
  const actor = {
    id: Number(ctx.state.user.id),
    ip: getClientIp(ctx),
    userAgent: getUserAgent(ctx),
    roleName: ctx.state.user.role?.name,
  };
  try {
    if (!key || key.length > 64)
      throw new AnipoWorkflowError(422, "ANIPO_INVALID_PARCEL", "شناسه بسته معتبر نیست");
    const { weight, boxSizeId } = ctx.request.body || {};
    const result = check
      ? await refreshReserveParcel(strapi, key, actor)
      : await submitReserveParcel(strapi, key, { weight, boxSizeId, forceRetry: true, actor });
    ctx.status = result.pending ? 202 : 200;
    ctx.body = result;
  } catch (error) {
    const known = error instanceof AnipoWorkflowError;
    ctx.status = known ? error.status : 500;
    ctx.body = {
      success: false,
      errorCode: known ? error.code : "ANIPO_PARCEL_ERROR",
      message: known ? error.message : "درخواست ارسال بسته انجام نشد؛ دوباره تلاش کنید",
    };
    strapi.log.error("Anipo parcel request failed", { groupKey: key, code: ctx.body.errorCode });
  }
}
