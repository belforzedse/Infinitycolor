import type { Strapi } from "@strapi/strapi";
import { logAdminBarcodeOperation } from "../../../../utils/adminActivity";
import {
  mapOrderStatusToAnipo,
  type AnipoCreateOrderPayload,
} from "../../../shipping/services/anipo";
import { buildAnipoOrderRecipient } from "./anipoOrder";

type AnipoService = {
  createOrUpdateOrder: (
    payload: AnipoCreateOrderPayload
  ) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  getOrderBarcode: (
    orderCode: string
  ) => Promise<{
    ok: boolean;
    data?: { issued: boolean; barcode?: string };
    error?: string;
  }>;
};

function computeOrderWeight(orderItems: unknown[]): number {
  let weight = 0;
  for (const it of orderItems) {
    const item = it as {
      Count?: number;
      product_variation?: { product?: { Weight?: number } };
    };
    const product = item?.product_variation?.product;
    const w = Number(product?.Weight ?? 100) || 100;
    const count = Number(item?.Count || 0);
    weight += w * count;
  }
  return weight > 0 ? weight : 100;
}

function computeOrderTotal(orderItems: unknown[], shippingCost: number): number {
  let sum = 0;
  for (const it of orderItems) {
    const item = it as { PerAmount?: number; Count?: number };
    const per = Number(item?.PerAmount || 0);
    const count = Number(item?.Count || 0);
    sum += per * count;
  }
  return sum + Number(shippingCost || 0);
}

export async function generateAnipoBarcodeHandler(strapi: Strapi, ctx: any) {
  const { id } = ctx.params;
  try {
    const order: any = await strapi.entityService.findOne(
      "api::order.order",
      Number(id),
      {
        populate: {
          user: { populate: { user_info: true } },
          delivery_address: {
            populate: {
              shipping_city: { populate: { shipping_province: true } },
            },
          },
          order_items: {
            populate: {
              product_variation: { populate: { product: true } },
            },
          },
        },
      }
    );

    if (!order) return ctx.notFound("order not found");
    if (order.ShippingBarcode) {
      ctx.body = {
        success: true,
        already: true,
        barcode: order.ShippingBarcode,
      };
      return;
    }

    const weight = computeOrderWeight(order.order_items || []);
    const {
      receiverName,
      cityName,
      provinceName,
      mobile,
      fullAddress,
      postalCode,
    } = buildAnipoOrderRecipient(order);

    if (!provinceName || !cityName) {
      return ctx.badRequest("نام استان یا شهر برای آنیپو ناقص است. دوباره تلاش کنید", {
        data: {
          success: false,
          errorCode: "ANIPO_MISSING_PROVINCE_CITY",
          message: "نام استان یا شهر برای آنیپو ناقص است. دوباره تلاش کنید",
        },
      });
    }

    if (!mobile) {
      return ctx.badRequest(
        "موبایل گیرنده برای صدور بارکد آنیپو لازم است. دوباره تلاش کنید",
        {
          data: {
            success: false,
            errorCode: "ANIPO_MISSING_MOBILE",
            message:
              "موبایل گیرنده برای صدور بارکد آنیپو لازم است. دوباره تلاش کنید",
          },
        }
      );
    }

    if (!fullAddress) {
      return ctx.badRequest(
        "نشانی گیرنده برای صدور بارکد آنیپو لازم است. دوباره تلاش کنید",
        {
          data: {
            success: false,
            errorCode: "ANIPO_MISSING_ADDRESS",
            message:
              "نشانی گیرنده برای صدور بارکد آنیپو لازم است. دوباره تلاش کنید",
          },
        }
      );
    }

    const orderCode = String(order.id);
    const orderTotal = computeOrderTotal(
      order.order_items || [],
      Number(order?.ShippingCost || 0)
    );
    const boxType = order?.ShippingBoxSizeId
      ? Number(order.ShippingBoxSizeId)
      : undefined;

    const anipo = strapi.service("api::shipping.anipo") as AnipoService;
    const createRes = await anipo.createOrUpdateOrder({
      order_code: orderCode,
      receiver_name: receiverName,
      receiver_province: provinceName,
      receiver_city: cityName,
      receiver_mobile: mobile,
      receiver_address: fullAddress,
      receiver_postal_code: postalCode,
      weight_g: weight,
      box_type: boxType,
      parcel_content: "پوشاک",
      order_total: orderTotal,
      order_status: mapOrderStatusToAnipo(order?.Status),
    });

    if (!createRes?.ok) {
      return ctx.badRequest(
        createRes?.error || "خطا در ثبت سفارش آنیپو. دوباره تلاش کنید",
        {
          data: {
            success: false,
            errorCode: "ANIPO_REGISTER_ERROR",
            message:
              createRes?.error || "خطا در ثبت سفارش آنیپو. دوباره تلاش کنید",
            anipo: createRes,
          },
        }
      );
    }

    const barcodeRes = await anipo.getOrderBarcode(orderCode);
    if (!barcodeRes?.ok) {
      return ctx.badRequest(
        barcodeRes?.error || "خطا در دریافت بارکد آنیپو. دوباره تلاش کنید",
        {
          data: {
            success: false,
            errorCode: "ANIPO_BARCODE_ERROR",
            message:
              barcodeRes?.error || "خطا در دریافت بارکد آنیپو. دوباره تلاش کنید",
            anipo: barcodeRes,
          },
        }
      );
    }

    if (!barcodeRes.data?.issued || !barcodeRes.data.barcode) {
      ctx.body = {
        success: true,
        pending: true,
        issued: false,
        message:
          "سفارش در آنیپو ثبت شد؛ بارکد هنوز صادر نشده — بعداً دوباره تلاش کنید",
      };
      return;
    }

    const barcode = barcodeRes.data.barcode;
    const updateData = {
      ShippingBarcode: barcode,
      ShippingWeight: weight,
      ShippingBoxSizeId: boxType || order?.ShippingBoxSizeId || 0,
    };
    await strapi.entityService.update("api::order.order", Number(id), {
      data: updateData as any,
    });

    try {
      const pluginUser = ctx.state?.user;
      if (pluginUser?.id) {
        const fullUser = await strapi.db
          .query("plugin::users-permissions.user")
          .findOne({ where: { id: pluginUser.id }, populate: ["role"] });
        if (fullUser) {
          const ip = ctx.request?.ip || ctx.ip || null;
          const userAgent =
            ctx.request?.headers?.["user-agent"] ||
            ctx.headers?.["user-agent"] ||
            null;

          await logAdminBarcodeOperation(
            strapi,
            Number(id),
            "generate",
            fullUser.id,
            barcode,
            undefined,
            ip,
            userAgent,
            fullUser.role?.name
          );
        }
      }
    } catch (activityError) {
      strapi.log.error("Failed to log admin activity for barcode generation", {
        orderId: id,
        error: (activityError as Error).message,
      });
    }

    ctx.body = {
      success: true,
      issued: true,
      data: { barcode, weight_g: weight, box_type: boxType },
    };
  } catch (error: any) {
    strapi.log.error(
      `[anipo] generate barcode error orderId=${ctx?.params?.id} message=${error?.message}`
    );
    return ctx.badRequest("صدور بارکد آنیپو ناموفق بود. دوباره تلاش کنید", {
      data: {
        success: false,
        errorCode: "GENERATE_BARCODE_FAILED",
        message: "صدور بارکد آنیپو ناموفق بود. دوباره تلاش کنید",
        error: error?.message,
      },
    });
  }
}
