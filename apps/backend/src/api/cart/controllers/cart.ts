/**
 * cart controller
 */

import { factories } from "@strapi/strapi";
import { Strapi } from "@strapi/strapi";
import { applyDiscountHandler } from "./handlers/applyDiscount";
import { getMyCartHandler } from "./handlers/getMyCart";
import { addItemHandler } from "./handlers/addItem";
import { updateItemHandler } from "./handlers/updateItem";
import { removeItemHandler } from "./handlers/removeItem";
import { checkStockHandler } from "./handlers/checkStock";
import { finalizeToOrderHandler } from "./handlers/finalizeToOrder";
import { shippingPreviewHandler } from "./handlers/shippingPreview";
import { shippingOptionsHandler } from "./handlers/shippingOptions";
import { checkoutQuoteHandler } from "./handlers/checkoutQuote";
import { checkoutAttemptHandler } from "./handlers/checkoutAttempt";
import { mergeGuestCartHandler } from "./handlers/mergeGuestCart";
import { findCartReportHandler } from "./handlers/findCartReport";
import { requireCapability } from "../../../utils/adminAuthorization";

export default factories.createCoreController(
  "api::cart.cart",
  ({ strapi }: { strapi: Strapi }) => ({
    async find(ctx) {
      if (!(await requireCapability(ctx, strapi, "report.carts.read"))) return;
      return findCartReportHandler(strapi)(ctx);
    },

    async applyDiscount(ctx) {
      return applyDiscountHandler(strapi)(ctx);
    },

    async getMyCart(ctx) {
      return getMyCartHandler(strapi)(ctx);
    },

    async addItem(ctx) {
      return addItemHandler(strapi)(ctx);
    },

    async mergeGuestCart(ctx) {
      return mergeGuestCartHandler(strapi)(ctx);
    },

    async updateItem(ctx) {
      return updateItemHandler(strapi)(ctx);
    },

    async removeItem(ctx) {
      return removeItemHandler(strapi)(ctx);
    },

    async checkStock(ctx) {
      return checkStockHandler(strapi)(ctx);
    },

    async finalizeToOrder(ctx) {
      return finalizeToOrderHandler(strapi)(ctx);
    },

    async checkoutQuote(ctx) {
      return checkoutQuoteHandler(strapi)(ctx);
    },

    async checkoutAttempt(ctx) {
      return checkoutAttemptHandler(strapi)(ctx);
    },

    async shippingPreview(ctx) {
      return shippingPreviewHandler(strapi)(ctx);
    },

    async shippingOptions(ctx) {
      return shippingOptionsHandler(strapi)(ctx);
    },
  })
);
