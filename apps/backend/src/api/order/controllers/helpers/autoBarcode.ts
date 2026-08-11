import type { Strapi } from "@strapi/strapi";
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

export async function autoGenerateBarcodeIfEligible(
  strapi: Strapi,
  orderId: number
) {
  try {
    if (!orderId || isNaN(Number(orderId))) return;

    const order: any = await strapi.entityService.findOne(
      "api::order.order",
      Number(orderId),
      {
        populate: {
          user: { populate: { user_info: true } },
          shipping: true,
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

    if (!order) return;
    if (order?.ShippingBarcode) return;

    const shippingId =
      typeof order?.shipping === "object"
        ? order?.shipping?.id
        : order?.shipping;
    if (Number(shippingId) === 4) return;

    let weight = 0;
    for (const it of order?.order_items || []) {
      const product = it?.product_variation?.product as {
        Weight?: number;
      } | null;
      const w = Number(product?.Weight ?? 100) || 100;
      const c = Number(it?.Count || 0);
      weight += w * c;
    }
    if (weight <= 0) weight = 100;

    const {
      receiverName,
      cityName,
      provinceName,
      mobile,
      fullAddress,
      postalCode,
    } = buildAnipoOrderRecipient(order);

    if (!provinceName || !cityName || !mobile || !fullAddress) return;

    let sum = 0;
    for (const it of order?.order_items || []) {
      const per = Number(it?.PerAmount || 0);
      const c = Number(it?.Count || 0);
      sum += per * c;
    }
    sum += Number(order?.ShippingCost || 0);

    const orderCode = String(order.id);
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
      order_total: sum,
      order_status: mapOrderStatusToAnipo(order?.Status),
    });

    if (!createRes?.ok) return;

    const barcodeRes = await anipo.getOrderBarcode(orderCode);
    if (!barcodeRes?.ok || !barcodeRes.data?.issued || !barcodeRes.data.barcode) {
      return;
    }

    await strapi.entityService.update("api::order.order", Number(orderId), {
      data: {
        ShippingBarcode: barcodeRes.data.barcode,
        ShippingWeight: weight,
        ShippingBoxSizeId: boxType || order?.ShippingBoxSizeId || 0,
      },
    });
  } catch (error: any) {
    try {
      strapi.log.error(
        `[anipo] auto barcode error orderId=${orderId} message=${error?.message}`
      );
    } catch {
      /* ignore logging failures */
    }
  }
}
