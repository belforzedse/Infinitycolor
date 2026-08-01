// @ts-nocheck
/**
 * local-user controller
 */

import { factories } from "@strapi/strapi";
import { validatePhone } from "../../auth/utils/validations";
import { normalizeRequiredProfileName } from "../../auth/utils/profile-names";
import bcrypt from "bcryptjs";

function requiredNames(ctx, firstName, lastName) {
  const normalizedFirstName = normalizeRequiredProfileName(firstName);
  const normalizedLastName = normalizeRequiredProfileName(lastName);
  if (!normalizedFirstName) {
    ctx.status = 400;
    ctx.body = { message: "نام الزامی است" };
    return null;
  }
  if (!normalizedLastName) {
    ctx.status = 400;
    ctx.body = { message: "نام خانوادگی الزامی است" };
    return null;
  }
  return { firstName: normalizedFirstName, lastName: normalizedLastName };
}

export default factories.createCoreController("api::local-user.local-user", {
  async createUser(ctx) {
    const {
      firstName = null,
      lastName = null,
      phone,
      password = null,
      birthDate = null,
      gender = null,
      bio = null,
      isActive = false,
      nationalCode = null,
      role = 1,
    } = ctx.request.body;

    if (validatePhone(ctx, phone) !== 200) {
      return ctx;
    }
    const names = requiredNames(ctx, firstName, lastName);
    if (!names) return ctx;

    const user = await strapi.service("api::local-user.local-user").createUser(ctx, {
      userData: {
        Phone: `+98${phone?.substring(1)}`,
        Password: password ? await bcrypt.hash(String(password), 10) : null,
        IsActive: isActive,
        user_role: role,
      },
      userInfoData: {
        FirstName: names.firstName,
        LastName: names.lastName,
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

  async updateUser(ctx) {
    const {
      firstName = null,
      lastName = null,
      birthDate = null,
      gender = null,
      bio = null,
      isActive = false,
      nationalCode = null,
      role = 1,
    } = ctx.request.body;
    const names = requiredNames(ctx, firstName, lastName);
    if (!names) return ctx;

    const user = await strapi.service("api::local-user.local-user").updateUser(ctx, {
      userData: {
        IsActive: isActive,
        user_role: role,
      },
      userInfoData: {
        FirstName: names.firstName,
        LastName: names.lastName,
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
});
