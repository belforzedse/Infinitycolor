// @ts-nocheck
/**
 * local-user-address controller
 */

import { factories } from "@strapi/strapi";
import { hasCapability } from "@repo/auth-core";
import { resolveCustomerTargetUserId } from "../../../utils/roles";
import { resolveAdminActor } from "../../../utils/adminAuthorization";
import {
  ADDRESS_UID,
  createAddressSnapshot,
  findAddressReferences,
  repointAddressReferences,
} from "../../../utils/addressSnapshot";

// Only Superadmin bypasses ownership scoping. Operational roles inherit the
// customer contract and therefore remain limited to their own addresses.
async function isSuperadminCaller(strapi, ctx): Promise<boolean> {
  const actor = await resolveAdminActor(strapi, ctx.state?.user);
  return Boolean(actor && hasCapability(actor.role, "system.users.manage"));
}

// Ownership check via a direct db query: the content-API query sanitizer rejects any
// `filters` referencing the `user` relation for roles without a grant on the users-permissions
// user type (Customer has none), so ownership can't be enforced through ctx.query filters here.
async function assertOwnsAddress(strapi, ctx, id: string | number): Promise<boolean> {
  const actorId = Number(ctx.state?.user?.id);
  const record = await strapi.db.query(ADDRESS_UID).findOne({
    where: { id },
    populate: ["user"],
  });
  // Temporary rows are order-only snapshots or customer-deleted addresses. They
  // remain in the database so historical orders keep their delivery details,
  // but behave as deleted on customer-facing CRUD routes.
  return !!record && record.IsTemporary !== true && Number(record.user?.id) === actorId;
}

// Give every referencing order/reserve group a private copy of the address as it
// stands right now. Snapshot and repoint run in one transaction ahead of the
// write: if the write then fails, those rows sit on a copy of their own unchanged
// values -- hidden from the shopper, and still correct.
async function freezeReferencesBeforeWrite(strapi, id: string | number) {
  const addressId = Number(id);
  const references = await findAddressReferences(strapi, addressId);
  if (references.total === 0) return null;

  return strapi.db.transaction(async ({ trx }) => {
    const current = await strapi.db.query(ADDRESS_UID).findOne({
      where: { id: addressId },
      populate: ["shipping_city", "user"],
      transacting: trx,
    });
    if (!current) return null;
    const snapshot = await createAddressSnapshot(strapi, current, trx);
    await repointAddressReferences(strapi, references, Number(snapshot.id), trx);
    return snapshot;
  });
}

export default factories.createCoreController(ADDRESS_UID, ({ strapi }) => ({
  async find(ctx) {
    if (!(await isSuperadminCaller(strapi, ctx))) {
      const actorId = Number(ctx.state?.user?.id);
      const ownRows = await strapi.db.query(ADDRESS_UID).findMany({
        where: { user: actorId, IsTemporary: false },
        select: ["id"],
      });
      // An empty $in array does not round-trip through Koa's ctx.query setter (which
      // serializes to a querystring and re-parses it): the filter silently vanishes and
      // the request falls through unfiltered. Force a sentinel id that can never match a
      // real row instead of relying on an empty array.
      const ownIds = ownRows.length ? ownRows.map((row) => row.id) : [-1];
      ctx.query = {
        ...ctx.query,
        filters: { id: { $in: ownIds } },
      };
    }
    return super.find(ctx);
  },

  async findOne(ctx) {
    if (!(await isSuperadminCaller(strapi, ctx))) {
      const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
      if (!owns) {
        return ctx.notFound("Address not found");
      }
    }
    return super.findOne(ctx);
  },

  async update(ctx) {
    if (!(await isSuperadminCaller(strapi, ctx))) {
      const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
      if (!owns) {
        return ctx.notFound("Address not found");
      }
    }

    // Deleting an address is not the only way to lose an order's destination --
    // editing one rewrites it in place for every order already shipped to it.
    // Hand those orders a frozen copy of the values they were placed with before
    // the row changes underneath them. The book row is then edited in place, so
    // its id survives: the storefront keeps that id in its addresses atom and in
    // a live checkout selection.
    //
    // Editing the book deliberately does NOT redirect an in-flight order. That
    // has to go through the admin order-address handler, which is the only caller
    // that bumps AnipoRecipientRevision and re-syncs the carrier -- a silent
    // rewrite here would ship to an address the carrier never heard about.
    await freezeReferencesBeforeWrite(strapi, ctx.params.id);

    return super.update(ctx);
  },

  async delete(ctx) {
    if (!(await isSuperadminCaller(strapi, ctx))) {
      const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
      if (!owns) {
        return ctx.notFound("Address not found");
      }
    }

    // Orders reference address rows directly. Hard-deleting a saved address lets
    // the database cascade-delete that relation, erasing the delivery address
    // from historical orders. Hide it from the customer's address book instead
    // while preserving the row and every existing order/reserve relation.
    const address = await strapi.entityService.update(ADDRESS_UID, ctx.params.id, {
      data: { IsTemporary: true },
    });
    const sanitized = await this.sanitizeOutput(address, ctx);
    return this.transformResponse(sanitized);
  },

  // Get addresses for the current logged-in user
  async getMyAddresses(ctx) {
    try {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;

      // Query addresses for the current user
      const { results: addresses, pagination } = await strapi
        .service("api::local-user-address.local-user-address")
        .find({
          filters: {
            user: userId,
            IsTemporary: false,
          },
          pagination: {
            page: 1,
            pageSize: 5000,
          },
          populate: {
            shipping_city: {
              populate: {
                shipping_province: true,
              },
            },
          },
          sort: { createdAt: "desc" },
        });

      return { data: addresses, meta: { pagination } };
    } catch (error) {
      return ctx.badRequest("An error occurred while fetching addresses", {
        error: error.message,
      });
    }
  },

  // Create a new address for the authenticated user
  async createAddress(ctx) {
    try {
      const userId = await resolveCustomerTargetUserId(ctx, strapi);
      if (!userId) return;
      const { shipping_city, PostalCode, FullAddress, Description } = ctx.request.body;

      // Validate required fields
      if (!shipping_city) {
        return ctx.badRequest("Shipping city is required");
      }

      if (!PostalCode) {
        return ctx.badRequest("Postal code is required");
      }

      if (!FullAddress) {
        return ctx.badRequest("Full address is required");
      }

      // Validate postal code format (assuming it should be numeric and 10 digits)
      const postalCodeRegex = /^\d{10}$/;
      if (!postalCodeRegex.test(PostalCode)) {
        return ctx.badRequest("Postal code must be 10 digits");
      }

      // Check if shipping city exists
      const cityExists = await strapi.db.query("api::shipping-city.shipping-city").findOne({
        where: { id: shipping_city },
      });

      if (!cityExists) {
        return ctx.badRequest("Invalid shipping city");
      }

      // Create the address
      const address = await strapi.entityService.create(
        "api::local-user-address.local-user-address",
        {
          data: {
            shipping_city,
            PostalCode,
            FullAddress,
            Description,
            IsTemporary: false,
            user: userId,
          },
          populate: {
            shipping_city: {
              populate: {
                shipping_province: true,
              },
            },
          },
        },
      );

      return { data: address };
    } catch (error) {
      return ctx.badRequest("An error occurred while creating the address", {
        error: error.message,
      });
    }
  },
}));
