import fs from "node:fs";
import path from "node:path";
import routes from "../routes/auth";

const readJson = (relative: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, relative), "utf8"));

describe("frozen authentication contract", () => {
  it("keeps the plugin user schema byte-for-field compatible", () => {
    const schema = readJson("../../../extensions/users-permissions/content-types/user/schema.json");
    expect(schema.collectionName).toBe("users");
    expect(schema.options).toEqual({ draftAndPublish: false });
    expect(schema.attributes).toEqual({
      username: { type: "string" },
      email: { type: "string", unique: true },
      provider: { type: "string" },
      password: { type: "string", private: true },
      resetPasswordToken: { type: "string", private: true },
      confirmationToken: { type: "string", private: true },
      confirmed: { type: "boolean", default: false },
      blocked: { type: "boolean", default: false },
      role: { type: "relation", relation: "manyToOne", target: "plugin::users-permissions.role" },
      phone: { type: "string", unique: true, required: true },
      IsVerified: { type: "boolean", default: false },
      AccountOrigin: {
        type: "enumeration",
        enum: ["Native", "WooRegistered", "WooGuest"],
        default: "Native",
        required: true,
      },
      ClaimedAt: { type: "datetime" },
      ProfileCompletedAt: { type: "datetime" },
      ProfileManagedByCustomer: { type: "boolean", default: true, required: true },
      SourceCreatedAt: { type: "datetime" },
      SourceUpdatedAt: { type: "datetime" },
      user_info: {
        type: "relation",
        relation: "oneToOne",
        target: "api::local-user-info.local-user-info",
        mappedBy: "user",
      },
      product_reviews: {
        type: "relation",
        relation: "oneToMany",
        target: "api::product-review.product-review",
        mappedBy: "user",
      },
      user_wallet: {
        type: "relation",
        relation: "oneToOne",
        target: "api::local-user-wallet.local-user-wallet",
        mappedBy: "user",
      },
      contracts: {
        type: "relation",
        relation: "oneToMany",
        target: "api::contract.contract",
        mappedBy: "local_user",
      },
      user_addresses: {
        type: "relation",
        relation: "oneToMany",
        target: "api::local-user-address.local-user-address",
        mappedBy: "user",
      },
      IsActive: { type: "boolean", default: true, required: true },
      user_role: {
        type: "relation",
        relation: "manyToOne",
        target: "api::local-user-role.local-user-role",
        inversedBy: "users",
      },
      cart: { type: "relation", relation: "oneToOne", target: "api::cart.cart", mappedBy: "user" },
      orders: {
        type: "relation",
        relation: "oneToMany",
        target: "api::order.order",
        mappedBy: "user",
      },
      external_source: { type: "string" },
      external_id: { type: "string" },
      removedAt: { type: "datetime" },
    });
  });

  it("keeps local profile and legacy user schemas intact", () => {
    const profile = readJson("../../local-user-info/content-types/local-user-info/schema.json");
    expect(profile.collectionName).toBe("local_user_infos");
    expect(profile.attributes).toEqual({
      FirstName: { type: "string" },
      LastName: { type: "string" },
      user: {
        type: "relation",
        relation: "oneToOne",
        target: "plugin::users-permissions.user",
        inversedBy: "user_info",
      },
      NationalCode: { type: "string" },
      BirthDate: { type: "date" },
      Sex: { type: "boolean" },
      Bio: { type: "text" },
    });

    const legacy = readJson("../../local-user/content-types/local-user/schema.json");
    expect(legacy.collectionName).toBe("local_users");
    expect(legacy.attributes).toEqual({
      Phone: { type: "string", required: true, unique: true },
      Password: { type: "string", private: true },
      IsVerified: { type: "boolean", default: false },
      product_reviews: {
        type: "relation",
        relation: "oneToMany",
        target: "api::product-review.product-review",
        mappedBy: "user",
      },
      user_wallet: {
        type: "relation",
        relation: "oneToOne",
        target: "api::local-user-wallet.local-user-wallet",
        mappedBy: "user",
      },
      contracts: {
        type: "relation",
        relation: "oneToMany",
        target: "api::contract.contract",
        mappedBy: "local_user",
      },
      user_addresses: {
        type: "relation",
        relation: "oneToMany",
        target: "api::local-user-address.local-user-address",
        mappedBy: "user",
      },
      IsActive: { type: "boolean", default: true, required: true },
      user_role: {
        type: "relation",
        relation: "manyToOne",
        target: "api::local-user-role.local-user-role",
        inversedBy: "users",
      },
      cart: { type: "relation", relation: "oneToOne", target: "api::cart.cart", mappedBy: "user" },
      orders: {
        type: "relation",
        relation: "oneToMany",
        target: "api::order.order",
        mappedBy: "user",
      },
      external_id: { type: "string", unique: false },
      external_source: { type: "string" },
      removedAt: { type: "datetime" },
      strapi_user: { type: "integer", unique: true },
    });
  });

  it("keeps the public route and response-field contract", () => {
    expect(
      routes.routes.map(({ method, path: routePath, handler }) => ({
        method,
        path: routePath,
        handler,
      })),
    ).toEqual([
      { method: "POST", path: "/auth/otp", handler: "auth.otp" },
      { method: "POST", path: "/auth/login", handler: "auth.login" },
      { method: "GET", path: "/auth/self", handler: "auth.self" },
      { method: "PUT", path: "/auth/self", handler: "auth.updateSelf" },
      { method: "POST", path: "/auth/welcome", handler: "auth.welcome" },
      { method: "POST", path: "/auth/register-info", handler: "auth.registerInfo" },
      { method: "POST", path: "/auth/login-with-password", handler: "auth.loginWithPassword" },
      { method: "POST", path: "/auth/reset-password", handler: "auth.resetPassword" },
    ]);

    const controller = fs.readFileSync(path.resolve(__dirname, "../controllers/auth.ts"), "utf8");
    for (const literal of [
      'message: "welcome"',
      "hasUser,",
      'message: "otp sent"',
      "otpToken,",
      '{ message: "login successful", token }',
      'message: "info updated"',
      'message: "رمز عبور با موفقیت تغییر کرد."',
      "Phone:",
      "phone:",
      "UserName:",
      "Email:",
      "isAdmin,",
      "roleName:",
    ])
      expect(controller).toContain(literal);
  });

  it("keeps the historical local-user bulk migration disabled by default", () => {
    const bootstrap = fs.readFileSync(path.resolve(__dirname, "../../../index.ts"), "utf8");
    expect(bootstrap).toContain('process.env.LEGACY_LOCAL_USER_MIGRATION_ENABLED !== "true"');
  });
});
