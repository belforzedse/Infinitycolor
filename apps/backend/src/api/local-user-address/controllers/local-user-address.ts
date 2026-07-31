// @ts-nocheck
/**
 * local-user-address controller
 */

import { factories } from "@strapi/strapi";
import {
  resolveCustomerTargetUserId,
  resolveUserRoleName,
  roleIsAllowed,
  MANAGEMENT_ROLES,
} from "../../../utils/roles";

const ADDRESS_UID = "api::local-user-address.local-user-address";

// Management roles bypass ownership scoping; Customers only ever see/modify their own rows.
async function isManagementCaller(strapi, ctx): Promise<boolean> {
  const roleName = await resolveUserRoleName(strapi, ctx.state?.user);
  return roleIsAllowed(roleName, MANAGEMENT_ROLES);
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
  return !!record && Number(record.user?.id) === actorId;
}

export default factories.createCoreController(
  ADDRESS_UID,
  ({ strapi }) => ({
    async find(ctx) {
      if (!(await isManagementCaller(strapi, ctx))) {
        const actorId = Number(ctx.state?.user?.id);
        const ownRows = await strapi.db.query(ADDRESS_UID).findMany({
          where: { user: actorId },
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
      if (!(await isManagementCaller(strapi, ctx))) {
        const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
        if (!owns) {
          return ctx.notFound("Address not found");
        }
      }
      return super.findOne(ctx);
    },

    async update(ctx) {
      if (!(await isManagementCaller(strapi, ctx))) {
        const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
        if (!owns) {
          return ctx.notFound("Address not found");
        }
      }
      return super.update(ctx);
    },

    async delete(ctx) {
      if (!(await isManagementCaller(strapi, ctx))) {
        const owns = await assertOwnsAddress(strapi, ctx, ctx.params.id);
        if (!owns) {
          return ctx.notFound("Address not found");
        }
      }
      return super.delete(ctx);
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
        const { shipping_city, PostalCode, FullAddress, Description } =
          ctx.request.body;

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
        const cityExists = await strapi.db
          .query("api::shipping-city.shipping-city")
          .findOne({
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
          }
        );

        return { data: address };
      } catch (error) {
        return ctx.badRequest("An error occurred while creating the address", {
          error: error.message,
        });
      }
    },
  })
);
