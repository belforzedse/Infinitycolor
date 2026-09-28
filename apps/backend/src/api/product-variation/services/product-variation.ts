/**
 * product-variation service
 */

import { factories } from '@strapi/strapi';
import { errors } from '@strapi/utils';

// A discount of 0 means "no discount". Stored as 0 it used to be charged as the
// price, so it is written as null instead.
const clearZeroDiscount = (data: any) => {
  if (data && data.DiscountPrice !== undefined && data.DiscountPrice !== null && Number(data.DiscountPrice) <= 0) {
    data.DiscountPrice = null;
  }
};

export default factories.createCoreService('api::product-variation.product-variation', ({ strapi }) => ({
  /**
   * Custom create method with discount price validation
   */
  async create(params: any) {
    clearZeroDiscount(params?.data);
    // Validate discount price if provided
    const { DiscountPrice, Price } = params.data;

    if (DiscountPrice !== undefined && DiscountPrice !== null && DiscountPrice > 0) {
      if (Price === undefined || Price === null) {
        throw new errors.ValidationError('قیمت اصلی الزامی است');
      }
      if (DiscountPrice >= Price) {
        throw new errors.ValidationError('قیمت تخفیف باید کمتر از قیمت اصلی باشد');
      }
    }

    return await super.create(params);
  },

  /**
   * Custom update method with discount price validation
   */
  async update(entityId: any, params: any) {
    clearZeroDiscount(params?.data);
    const { DiscountPrice, Price } = params.data || {};

    // If either price field is being updated, validate the combination
    if (DiscountPrice !== undefined || Price !== undefined) {
      // Fetch current entity to get existing values
      const existing = await strapi.entityService.findOne(
        'api::product-variation.product-variation',
        entityId,
        { fields: ['Price', 'DiscountPrice'] }
      );

      if (!existing) {
        throw new errors.NotFoundError('محصول یافت نشد');
      }

      // Use updated values or fall back to existing ones
      const finalPrice = Price !== undefined ? Price : existing.Price;
      const finalDiscountPrice = DiscountPrice !== undefined ? DiscountPrice : existing.DiscountPrice;

      // Validate if discount price is set and greater than 0
      if (finalDiscountPrice !== null && finalDiscountPrice > 0) {
        if (finalPrice === null || finalPrice === undefined) {
          throw new errors.ValidationError('قیمت اصلی الزامی است');
        }
        if (finalDiscountPrice >= finalPrice) {
          throw new errors.ValidationError('قیمت تخفیف باید کمتر از قیمت اصلی باشد');
        }
      }
    }

    return await super.update(entityId, params);
  },
}));
