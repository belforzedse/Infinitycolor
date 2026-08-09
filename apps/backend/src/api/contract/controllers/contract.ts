/**
 * contract controller
 */

import { factories } from '@strapi/strapi'
import { requireCapability } from '../../../utils/adminAuthorization';

export default factories.createCoreController('api::contract.contract', ({ strapi }) => ({
  async create(ctx) {
    if (!(await requireCapability(ctx, strapi, 'order.manual.create'))) return;
    return super.create(ctx);
  },
}));
