export const PLUGIN_ROLE_LABELS: Record<string, string> = {
  Superadmin: "سوپر ادمین",
  "Store manager": "مدیر فروشگاه",
  "Store Manager": "مدیر فروشگاه",
  "Store Manager 2": "مدیر فروشگاه ۲",
  "Seller 1": "فروشنده ۱",
  "Seller 2": "فروشنده ۲",
  Finance: "مالی",
  Founder: "بنیان‌گذار",
  Customer: "مشتری",
  Editor: "ویرایشگر",
};

export const translatePluginRoleLabel = (roleName?: string | null) => {
  if (!roleName) return "";
  return PLUGIN_ROLE_LABELS[roleName] ?? roleName;
};

type UserRoleLabelSource = {
  role?: { name?: string | null } | null;
  user_role?: { Title?: string | null } | null;
};

/**
 * Plugin roles are the authorization source of truth. `user_role` belongs to
 * the retired local-user model and is retained only as a display fallback for
 * records that have not been migrated yet.
 */
export const resolveUserRoleLabel = (user: UserRoleLabelSource): string =>
  translatePluginRoleLabel(user.role?.name) || user.user_role?.Title || "-";

/**
 * Plugin role names considered "management" (staff) roles.
 * Mirrors backend `MANAGEMENT_ROLES` in apps/backend/src/utils/roles.ts.
 * Keep in sync if backend role names change.
 */
export const MANAGEMENT_ROLE_NAMES = [
  "Superadmin",
  "Seller 1",
  "Seller 2",
  "Store Manager",
  "Store Manager 2",
  "Finance",
  "Founder",
  "Editor",
] as const;

const ASSIGNABLE_ROLE_TYPES = new Set([
  "customer",
  "editor",
  "seller-1",
  "seller-2",
  "store-manager",
  "store-manager-2",
  "finance",
  "founder",
  "superadmin",
]);

export const isAssignablePluginRole = (role: any): boolean => {
  const type = String(role?.type ?? role?.attributes?.type ?? "").trim().toLowerCase();
  return ASSIGNABLE_ROLE_TYPES.has(type);
};

/**
 * Build the Strapi REST query fragment that restricts a users listing to the
 * management/staff plugin roles (filtered by `role.name`). Returns the fragment
 * WITHOUT a leading separator, e.g. `filters[role][name][$in][0]=Superadmin&...`.
 */
export const buildManagerRoleFilterQuery = (): string =>
  MANAGEMENT_ROLE_NAMES.map(
    (roleName, index) =>
      `filters[role][name][$in][${index}]=${encodeURIComponent(roleName)}`,
  ).join("&");
