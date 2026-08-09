import type { Strapi } from "@strapi/strapi";
import { logAdminBarcodeOperation } from "../../../../utils/adminActivity";
import { requireCapability } from "../../../../utils/adminAuthorization";

export async function adminVoidBarcodeHandler(strapi: Strapi, ctx: any) {
  const { id } = ctx.params;
  const { reason } = ctx.request.body || {};

  try {
    const actor = await requireCapability(ctx, strapi, "order.shipping.manage");
    if (!actor) return;
    const fullUser = actor.user;
    const roleName = fullUser?.role?.name;

    const order = await strapi.db.query("api::order.order").findOne({
      where: { id },
      populate: {
        contract: true,
      },
    });

    if (!order) {
      return ctx.notFound("Order not found");
    }

    if (!order.ShippingBarcode) {
      return ctx.badRequest("No shipping barcode to remove", {
        data: { error: "no_barcode" },
      });
    }

    await strapi.db.query("api::order.order").update({
      where: { id },
      data: {
        ShippingBarcode: null,
      },
    });

    await strapi.db.query("api::order-log.order-log").create({
      data: {
        order: id,
        Action: "Update",
        Description: "Admin removed shipping barcode",
        Changes: {
          reason: reason || "",
          previousBarcode: order.ShippingBarcode,
        },
              PerformedBy: `Admin User ${fullUser.id}`,
      },
    });

    // Log admin activity
    try {
      const ip = ctx.request?.ip || ctx.ip || null;
      const userAgent = ctx.request?.headers?.["user-agent"] || ctx.headers?.["user-agent"] || null;

      await logAdminBarcodeOperation(
        strapi,
        id,
        "void",
        fullUser.id,
        order.ShippingBarcode || undefined,
        reason || undefined,
        ip,
        userAgent,
        roleName,
      );
    } catch (activityError) {
      strapi.log.error("Failed to log admin activity for barcode void", {
        orderId: id,
        error: (activityError as Error).message,
      });
    }

    return {
      data: {
        success: true,
      },
    };
  } catch (error: any) {
    strapi.log.error("adminVoidBarcode error", error);
    return ctx.internalServerError("Failed to remove shipping barcode", {
      data: { error: error.message },
    });
  }
}
