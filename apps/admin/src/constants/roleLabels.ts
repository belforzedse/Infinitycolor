export const PLUGIN_ROLE_LABELS: Record<string, string> = {
  Superadmin: "سوپر ادمین",
  "Store manager": "مدیر فروشگاه",
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
  "Store manager",
  "Founder",
  "Editor",
] as const;

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
