/**
 * plugin-user controller
 * Handles plugin user (users-permissions.user) management operations
 */

import { validatePhone } from "../../auth/utils/validations";
import { normalizeRequiredProfileName } from "../../auth/utils/profile-names";
import {
  customerPhoneSearchAlternatives,
  personNameSearchAlternatives,
} from "../../../utils/personIdentitySearch";

type CustomerSearchRow = {
  id: number;
  phone?: string | null;
  IsActive?: boolean | null;
  blocked?: boolean | null;
  user_info?: {
    FirstName?: string | null;
    LastName?: string | null;
  } | null;
};

export default {
  async searchCustomers(ctx) {
    // Wallet search is identity-only and includes staff. Adjustment still
    // refuses the actor's own wallet.
    const query = String(ctx.query?.q || "").trim();
    if (query.length < 2) {
      ctx.badRequest("Search query must contain at least two characters");
      return;
    }

    const requestedPageSize = Number(ctx.query?.pageSize || 6);
    const pageSize = Number.isFinite(requestedPageSize)
      ? Math.min(Math.max(Math.trunc(requestedPageSize), 1), 20)
      : 6;
    const users = await strapi.query("plugin::users-permissions.user").findMany({
      where: {
        removedAt: { $null: true },
        $or: [
          ...customerPhoneSearchAlternatives(query),
          ...personNameSearchAlternatives(query),
        ],
      },
      select: ["id", "phone", "IsActive", "blocked"],
      populate: {
        user_info: { select: ["FirstName", "LastName"] },
      },
      orderBy: { id: "desc" },
      limit: pageSize,
    });

    const data = (users as CustomerSearchRow[]).map((customer) => ({
      id: customer.id,
      phone: customer.phone ?? null,
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
