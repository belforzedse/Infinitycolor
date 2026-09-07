/**
 * plugin-user controller
 * Handles plugin user (users-permissions.user) management operations
 */

import { validatePhone } from "../../auth/utils/validations";
import { normalizeRequiredProfileName } from "../../auth/utils/profile-names";
import {
  canonicalCustomerPhone,
  customerPhoneStorageVariants,
  normalizeCustomerPhoneDigits,
} from "../../../utils/customerPhoneIdentity";

/**
 * Phones are stored as either `+989…` or `09…`, and admins paste them with
 * Persian or Arabic numerals, so a raw `$containsi` on the typed query misses
 * most real numbers. A complete number is matched against both stored shapes;
 * a partial one is matched on the national part, which both shapes contain.
 */
function customerPhoneSearchFilters(query: string): Array<Record<string, unknown>> {
  const digits = normalizeCustomerPhoneDigits(query);
  if (!digits) return [];

  const canonical = canonicalCustomerPhone(digits);
  if (canonical) {
    return [{ phone: { $in: customerPhoneStorageVariants(canonical) } }];
  }

  const nationalPart = digits.replace(/^\+?98/, "").replace(/^0+/, "");
  if (!nationalPart) return [];
  return [{ phone: { $containsi: nationalPart } }];
}

export default {
  async searchCustomers(ctx) {
    const query = String(ctx.query?.q || "").trim();
    if (query.length < 2) {
      ctx.badRequest("Search query must contain at least two characters");
      return;
    }

    const requestedPageSize = Number(ctx.query?.pageSize || 6);
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(Math.trunc(requestedPageSize), 1), 20)
      : 6;
    const words = query.split(/\s+/).filter(Boolean);
    const nameFilters: Array<Record<string, unknown>> = [
      { user_info: { FirstName: { $containsi: query } } },
      { user_info: { LastName: { $containsi: query } } },
    ];
    if (words.length > 1) {
      nameFilters.push({
        $and: [
          { user_info: { FirstName: { $containsi: words[0] } } },
          { user_info: { LastName: { $containsi: words.slice(1).join(" ") } } },
        ],
      });
    }

    const customers = await strapi.query("plugin::users-permissions.user").findMany({
      where: {
        removedAt: { $null: true },
        role: { type: "customer" },
        $or: [...customerPhoneSearchFilters(query), ...nameFilters],
      },
      select: ["id", "phone", "IsActive", "blocked"],
      populate: {
        user_info: { select: ["FirstName", "LastName"] },
      },
      orderBy: { id: "desc" },
      limit: pageSize,
    });

    const data = customers.map((customer: any) => ({
      id: customer.id,
      phone: customer.phone,
      firstName: customer.user_info?.FirstName || null,
      lastName: customer.user_info?.LastName || null,
      isActive: customer.IsActive !== false && customer.blocked !== true,
    }));

    ctx.body = {
      data,
      meta: { pageSize, count: data.length },
    };
  },

  async createPluginUser(ctx) {
    const {
      firstName = null,
      lastName = null,
      phone,
      password = null,
      birthDate = null,
      gender = null,
      bio = null,
      isActive = true,
      nationalCode = null,
      role = null,
    } = ctx.request.body;

    if (validatePhone(ctx, phone) !== 200) {
      return ctx;
    }
    const normalizedFirstName = normalizeRequiredProfileName(firstName);
    const normalizedLastName = normalizeRequiredProfileName(lastName);
    if (!normalizedFirstName) {
      ctx.status = 400;
      ctx.body = { message: "نام الزامی است" };
      return ctx;
    }
    if (!normalizedLastName) {
      ctx.status = 400;
      ctx.body = { message: "نام خانوادگی الزامی است" };
      return ctx;
    }

    const user = await strapi.service("api::plugin-user.plugin-user").createPluginUser(ctx, {
      userData: {
        phone,
        password,
        isActive,
        role,
      },
      userInfoData: {
        FirstName: normalizedFirstName,
        LastName: normalizedLastName,
        BirthDate: birthDate,
        Sex: gender,
        Bio: bio,
        NationalCode: nationalCode,
      },
    });

    if (!user) {
      return ctx;
    }

    ctx.body = user;
  },
};
