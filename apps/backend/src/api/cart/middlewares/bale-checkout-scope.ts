import type { Strapi } from "@strapi/strapi";
import {
  loadBaleCheckoutCart,
  readBaleCheckoutForAttempt,
  readOwnedBaleCheckout,
} from "../../bale-checkout/services/handoff";

const checkoutIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export default (_config: unknown, { strapi }: { strapi: Strapi }) =>
  async (ctx: any, next: () => Promise<unknown>) => {
    const { query, body } = ctx.request;
    const checkoutId = query?.baleCheckoutId;
    const attemptIds = [body?.supersedeAttemptId, body?.attemptId, query?.attemptId];
    if (attemptIds.some((id) => id != null && typeof id !== "string")) return ctx.badRequest();
    const userId = Number(ctx.state.user?.id);
    if (checkoutId !== undefined) {
      ctx.set("Cache-Control", "no-store");
      if (!Number.isSafeInteger(userId) || userId <= 0) return ctx.unauthorized();
      if (typeof checkoutId !== "string" || !checkoutIdPattern.test(checkoutId)) {
        return ctx.notFound();
      }
      const checkout = await readOwnedBaleCheckout(strapi, checkoutId, userId);
      if (!checkout) return ctx.notFound();
      if (!checkout.orderId && checkout.expiresAt.getTime() <= Date.now()) {
        ctx.status = 410;
        ctx.body = { data: { success: false, errorCode: "BALE_CHECKOUT_EXPIRED" } };
        return;
      }
      // A Bale link can never supersede a different checkout.
      if (body?.supersedeAttemptId) return ctx.badRequest();
      ctx.state.baleCheckoutScope = {
        checkout,
        cart: await loadBaleCheckoutCart(strapi, checkout),
      };
      // The recipient given to the bot is part of the order the bot quoted:
      // shipping, quote and finalize always use it, whatever the page sends.
      const recipient = checkout.handoff?.recipient;
      if (recipient && body && typeof body === "object" && !Array.isArray(body)) {
        delete body.addressId;
        body.addressPayload = {
          shipping_city: recipient.cityId,
          PostalCode: recipient.postalCode,
          FullAddress: recipient.address,
          FullName: recipient.fullName,
          Phone: recipient.phone,
          save: body.addressPayload?.save !== false,
        };
        body.recipient = { FullName: recipient.fullName, Phone: recipient.phone };
        // A reserve shipment carries its own address, so it cannot apply here.
        delete body.reserveGroupId;
        delete body.reserveShipping;
        // The page's phone field holds the recipient's number, which may be
        // someone else's. Gateways (SnappPay credit above all) must get the
        // signed-in payer's own mobile, which finalize falls back to.
        delete body.mobile;
      }
    } else if (userId > 0) {
      // A regular checkout may not resume or abandon a Bale payment by passing
      // an attempt id copied from another tab.
      for (const id of attemptIds) {
        if (
          typeof id === "string" &&
          id.length <= 128 &&
          id.trim() &&
          await readBaleCheckoutForAttempt(strapi, id.trim(), userId)
        ) return ctx.badRequest();
      }
    }

    return next();
  };
