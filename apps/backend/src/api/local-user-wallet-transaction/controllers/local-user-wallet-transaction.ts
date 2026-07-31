// @ts-nocheck
/**
 * local-user-wallet-transaction controller
 */

import { factories } from '@strapi/strapi'
import {
  resolveUserRoleName,
  roleIsAllowed,
  MANAGEMENT_ROLES,
} from '../../../utils/roles'

const TRANSACTION_UID = 'api::local-user-wallet-transaction.local-user-wallet-transaction'
const WALLET_UID = 'api::local-user-wallet.local-user-wallet'

async function isManagementCaller(strapi, ctx): Promise<boolean> {
  const roleName = await resolveUserRoleName(strapi, ctx.state?.user)
  return roleIsAllowed(roleName, MANAGEMENT_ROLES)
}

// Ownership is via transaction.user_wallet.user; the content-API query sanitizer rejects any
// `filters` referencing that relation for Customer (no grant on the users-permissions user or
// wallet types), so ownership can't be enforced through ctx.query filters here.
async function getOwnWalletId(strapi, actorId: number): Promise<number | null> {
  const wallet = await strapi.db.query(WALLET_UID).findOne({
    where: { user: actorId },
    select: ['id'],
  })
  return wallet?.id ?? null
}

async function assertOwnsTransaction(strapi, ctx, id: string | number): Promise<boolean> {
  const actorId = Number(ctx.state?.user?.id)
  const record = await strapi.db.query(TRANSACTION_UID).findOne({
    where: { id },
    populate: { user_wallet: { populate: ['user'] } },
  })
  return !!record && Number(record.user_wallet?.user?.id) === actorId
}

export default factories.createCoreController(TRANSACTION_UID, ({ strapi }) => ({
  async find(ctx) {
    if (!(await isManagementCaller(strapi, ctx))) {
      const actorId = Number(ctx.state?.user?.id)
      const walletId = await getOwnWalletId(strapi, actorId)
      const ownRows = walletId
        ? await strapi.db.query(TRANSACTION_UID).findMany({
            where: { user_wallet: walletId },
            select: ['id'],
          })
        : []
      // An empty $in array does not round-trip through Koa's ctx.query setter (which
      // serializes to a querystring and re-parses it): the filter silently vanishes and
      // the request falls through unfiltered. Force a sentinel id that can never match a
      // real row instead of relying on an empty array.
      const ownIds = ownRows.length ? ownRows.map((row) => row.id) : [-1]
      ctx.query = {
        ...ctx.query,
        filters: { id: { $in: ownIds } },
      }
    }
    return super.find(ctx)
  },

  async findOne(ctx) {
    if (!(await isManagementCaller(strapi, ctx))) {
      const owns = await assertOwnsTransaction(strapi, ctx, ctx.params.id)
      if (!owns) {
        return ctx.notFound('Transaction not found')
      }
    }
    return super.findOne(ctx)
  },
}));
