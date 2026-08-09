export const PLUGIN_ROLE_LABELS: Record<string, string> = {
  Superadmin: "سوپر ادمین",
  "Store manager": "مدیر فروشگاه",
  "Store Manager": "مدیر فروشگاه",
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
