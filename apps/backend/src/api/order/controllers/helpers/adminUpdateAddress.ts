import type { Strapi } from "@strapi/strapi";
import { canonicalIranPhone } from "@repo/auth-core";
import { normalizeAnipoPostalCode } from "./anipoOrder";
import { requireCapability } from "../../../../utils/adminAuthorization";
import { getClientIp, getUserAgent } from "../../../../utils/getClientIp";
import { logAdminOrderAddressUpdate } from "../../../../utils/adminActivity";
import { lockReserveGroup } from "../../../reserve-group/lib/reserve-group";
import { runRawSql } from "../../../../utils/transactionExecutor";
import { enqueueAnipoRecipientSync } from "../../../../queue/anipo-recipient";

type AddressInput = {
  shippingCityId: number;
  fullAddress: string;
  postalCode: string;
  recipientName: string;
  recipientPhone: string;
};

export class OrderAddressValidationError extends Error {
  constructor(readonly field: keyof AddressInput | "orderId", message: string) {
    super(message);
    this.name = "OrderAddressValidationError";
  }
}

const cleanText = (value: unknown) => String(value ?? "").normalize("NFC").trim().replace(/\s+/g, " ");

export function parseOrderAddressInput(value: unknown): AddressInput {
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const allowed = new Set([
    "shippingCityId",
    "fullAddress",
    "postalCode",
    "recipientName",
    "recipientPhone",
  ]);
  const rejected = Object.keys(input).filter((key) => !allowed.has(key));
  if (rejected.length) {
    throw new OrderAddressValidationError("fullAddress", `Unsupported fields: ${rejected.join(", ")}`);
  }

  const shippingCityId = Number(input.shippingCityId);
  if (!Number.isSafeInteger(shippingCityId) || shippingCityId <= 0) {
    throw new OrderAddressValidationError("shippingCityId", "استان و شهر را انتخاب کنید");
  }
  const fullAddress = cleanText(input.fullAddress);
  if (fullAddress.length < 5 || fullAddress.length > 1_000) {
    throw new OrderAddressValidationError("fullAddress", "آدرس ارسال باید بین ۵ تا ۱۰۰۰ نویسه باشد");
  }
  const postalCode = normalizeAnipoPostalCode(input.postalCode);
  if (!postalCode) {
    throw new OrderAddressValidationError("postalCode", "کدپستی باید ۱۰ رقم معتبر باشد");
  }
  const recipientName = cleanText(input.recipientName);
  if (!recipientName || recipientName.length > 255) {
    throw new OrderAddressValidationError("recipientName", "نام گیرنده معتبر نیست");
  }
  const recipientPhone = canonicalIranPhone(input.recipientPhone);
  if (!recipientPhone) {
    throw new OrderAddressValidationError("recipientPhone", "شماره تماس گیرنده معتبر نیست");
  }
  return { shippingCityId, fullAddress, postalCode, recipientName, recipientPhone };
}

const comparable = (address: any) => ({
  shippingCityId: Number(address?.shipping_city?.id || 0),
  fullAddress: cleanText(address?.FullAddress),
  postalCode: normalizeAnipoPostalCode(address?.PostalCode) || "",
  recipientName: cleanText(address?.FullName),
  recipientPhone: canonicalIranPhone(address?.Phone) || "",
});

const changedFields = (before: ReturnType<typeof comparable>, after: AddressInput) =>
  (Object.keys(after) as Array<keyof AddressInput>).filter(
    (key) => String(before[key] ?? "") !== String(after[key] ?? ""),
  );

const hasActiveAnipoRegistration = (order: any) =>
  Boolean(order.AnipoSubmittedAt) &&
  !["Stopped", "Voided"].includes(String(order.AnipoBarcodeState || "Pending"));

const syncStatus = (orders: any[]) => {
  const active = orders.filter(hasActiveAnipoRegistration);
  if (!active.length) return { required: false, status: "not_required" as const };
  if (active.every((order) => order.AnipoRecipientSyncState === "Synced")) {
    return { required: true, status: "synced" as const };
  }
  if (active.some((order) => order.AnipoRecipientSyncState === "NeedsAttention")) {
    return { required: true, status: "needs_attention" as const };
  }
  return { required: true, status: "pending" as const };
};

export async function adminUpdateAddressHandler(strapi: Strapi, ctx: any) {
  if (!(await requireCapability(ctx, strapi, "order.address.update"))) return;

  const orderId = Number(ctx.params?.id);
  if (!Number.isSafeInteger(orderId) || orderId <= 0) {
    return ctx.badRequest("شناسه سفارش نامعتبر است");
  }

  let input: AddressInput;
  try {
    input = parseOrderAddressInput(ctx.request?.body?.data);
  } catch (error) {
    if (error instanceof OrderAddressValidationError) {
      return ctx.badRequest(error.message, { data: { field: error.field } });
    }
    throw error;
  }

  const city = await strapi.db.query("api::shipping-city.shipping-city").findOne({
    where: { id: input.shippingCityId },
    populate: { shipping_province: true },
  });
  if (!city?.shipping_province) {
    return ctx.badRequest("استان و شهر معتبر نیست");
  }

  const result = await strapi.db.transaction(async ({ trx }) => {
    await runRawSql(strapi, "SELECT id FROM orders WHERE id = ? FOR UPDATE", [orderId], trx);
    let order = await strapi.db.query("api::order.order").findOne({
      where: { id: orderId },
      populate: {
        user: true,
        reserve_shipment: true,
        delivery_address: { populate: { shipping_city: true } },
      },
      transacting: trx,
    } as any);
    if (!order) return { notFound: true as const };

    const reserveGroupId = Number(order.reserve_shipment?.id || 0) || null;
    if (reserveGroupId) {
      await lockReserveGroup(strapi, reserveGroupId, trx);
      order = await strapi.db.query("api::order.order").findOne({
        where: { id: orderId },
        populate: {
          user: true,
          reserve_shipment: true,
          delivery_address: { populate: { shipping_city: true } },
        },
        transacting: trx,
      } as any);
    }

    const memberOrders = reserveGroupId
      ? await strapi.db.query("api::order.order").findMany({
          where: { reserve_shipment: { id: reserveGroupId } },
          populate: { delivery_address: { populate: { shipping_city: true } } },
          orderBy: { id: "asc" },
          transacting: trx,
        } as any)
      : [order];
    const group = reserveGroupId
      ? await strapi.db.query("api::reserve-group.reserve-group").findOne({
          where: { id: reserveGroupId },
          populate: { delivery_address: { populate: { shipping_city: true } } },
          transacting: trx,
        } as any)
      : null;
    const fields = changedFields(comparable(order.delivery_address), input);
    const allAlreadyMatch =
      fields.length === 0 &&
      memberOrders.every(
        (member: any) => changedFields(comparable(member.delivery_address), input).length === 0,
      ) &&
      (!group || changedFields(comparable(group.delivery_address), input).length === 0);
    if (allAlreadyMatch) {
      return {
        noChange: true as const,
        address: order.delivery_address,
        orders: memberOrders,
        reserveGroupId,
      };
    }

    const auditFields = fields.length
      ? fields
      : (["shippingCityId", "fullAddress", "postalCode", "recipientName", "recipientPhone"] as const);
    const affectedOrderIds = memberOrders.map((member: any) => Number(member.id));
    const snapshot = await strapi.db.query("api::local-user-address.local-user-address").create({
      data: {
        shipping_city: input.shippingCityId,
        PostalCode: input.postalCode,
        Description: order.delivery_address?.Description || null,
        FullAddress: input.fullAddress,
        FullName: input.recipientName,
        Phone: input.recipientPhone,
        IsTemporary: true,
        user: Number(order.user?.id || 0) || undefined,
      },
      transacting: trx,
    } as any);

    const now = new Date();
    const queued: Array<{ orderId: number; revision: number }> = [];
    for (const member of memberOrders) {
      const activeAnipo = hasActiveAnipoRegistration(member);
      const revision = Number(member.AnipoRecipientRevision || 0) + (activeAnipo ? 1 : 0);
      await strapi.db.query("api::order.order").update({
        where: { id: member.id },
        data: {
          delivery_address: snapshot.id,
          ...(activeAnipo
            ? {
                AnipoRecipientRevision: revision,
                AnipoRecipientSyncState: "Pending",
                AnipoRecipientSyncAttempts: 0,
                AnipoRecipientSyncLastAttemptAt: null,
                AnipoRecipientSyncLastError: null,
              }
            : {}),
        },
        transacting: trx,
      } as any);
      if (activeAnipo) queued.push({ orderId: Number(member.id), revision });
      await logAdminOrderAddressUpdate(
        strapi,
        Number(member.id),
        [...auditFields],
        Number(member.delivery_address?.id || order.delivery_address?.id || 0) || null,
        Number(snapshot.id),
        Number(ctx.state.user.id),
        { reserveGroupId, affectedOrderIds },
        getClientIp(ctx),
        getUserAgent(ctx),
        ctx.state?.user?.role?.name,
        trx,
      );
    }
    if (reserveGroupId) {
      await strapi.db.query("api::reserve-group.reserve-group").update({
        where: { id: reserveGroupId },
        data: { delivery_address: snapshot.id, lastActivityAt: now },
        transacting: trx,
      } as any);
    }

    return {
      noChange: false as const,
      address: { ...snapshot, shipping_city: city },
      orders: memberOrders.map((member: any) => ({
        ...member,
        ...(queued.some((queuedOrder) => queuedOrder.orderId === Number(member.id))
          ? { AnipoRecipientSyncState: "Pending" }
          : {}),
      })),
      reserveGroupId,
      queued,
      affectedOrderIds,
    };
  });

  if ("notFound" in result) return ctx.notFound("سفارش پیدا نشد");
  for (const pending of result.queued || []) {
    try {
      await enqueueAnipoRecipientSync(pending.orderId, pending.revision);
    } catch (error) {
      strapi.log.error("Failed to enqueue Anipo recipient synchronization", {
        orderId: pending.orderId,
        revision: pending.revision,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const address = result.address;
  ctx.body = {
    data: {
      orderId,
      noChange: result.noChange,
      affectedOrderIds: result.affectedOrderIds || result.orders.map((order: any) => Number(order.id)),
      reserveGroupId: result.reserveGroupId,
      deliveryAddress: {
        id: Number(address.id),
        fullAddress: address.FullAddress,
        postalCode: address.PostalCode,
        recipientName: address.FullName,
        recipientPhone: address.Phone,
        shippingCity: {
          id: Number(address.shipping_city?.id),
          title: address.shipping_city?.Title,
          shippingProvince: {
            id: Number(address.shipping_city?.shipping_province?.id),
            title: address.shipping_city?.shipping_province?.Title,
          },
        },
      },
      carrierSync: syncStatus(result.orders),
    },
  };
  return ctx.body;
}
