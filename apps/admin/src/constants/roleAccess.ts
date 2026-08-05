/**
 * Centralized role-based access rules for the super-admin area.
 *
 * Single source of truth shared by the sidebar (which parents to hide) and the
 * ClientLayout route guard (which URL prefixes to block). Backend enforcement is
 * the real protection; these rules keep the UI consistent and block direct-URL
 * navigation for every non-Superadmin administrative role.
 */

/** Sidebar parent ids hidden from Founders (mirrors the restricted sections). */
export const FOUNDER_HIDDEN_PARENT_IDS = new Set<string>([
  "customization",
  "blog",
  "faq",
  "stories",
  "users",
  "settings",
  "payment-methods",
  "carts",
]);

/**
 * Route prefixes a Founder must NOT open (even by typing the URL).
 * Note: `/reports/product-sales` is intentionally NOT here — it is the
 * single sales report Founders are allowed to view under «گزارشات فروش».
 */
export const FOUNDER_FORBIDDEN_PREFIXES: string[] = [
  "/customization",
  "/blog",
  "/faq",
  "/stories",
  "/settings",
  "/users",
  "/payment-methods",
  "/carts",
  "/purgeall",
  "/orders/add",
  "/products/homepage",
  "/products/gif-promo",
  "/products/homepage-custom-section",
  "/shipping/provinces",
  "/reports/traffic",
  "/reports/admin-activity",
];

export const STORE_MANAGER_HIDDEN_PARENT_IDS = new Set<string>([
  "customization",
  "blog",
  "faq",
  "stories",
  "users",
  "settings",
  "reports",
  "payment-methods",
  "carts",
]);

export const STORE_MANAGER_HIDDEN_CHILD_IDS = new Set<string>([
  "homepage-products",
  "homepage-gif-promo-products",
  "homepage-custom-section",
  "shipping-provinces",
  "shipping-cities",
  "admin-activity",
]);

export const STORE_MANAGER_FORBIDDEN_PREFIXES: string[] = [
  "/customization",
  "/blog",
  "/faq",
  "/stories",
  "/users",
  "/settings",
  "/reports",
  "/payment-methods",
  "/carts",
  "/purgeall",
  "/orders/add",
  "/products/homepage",
  "/products/gif-promo",
  "/products/homepage-custom-section",
  "/shipping/provinces",
];

export const EDITOR_ALLOWED_PREFIXES: string[] = ["/blog"];

const normalizeRole = (roleName?: string | null): string =>
  (roleName ?? "").toString().trim().toLowerCase();

/** True when the given role name is the Founder role (case/spacing tolerant). */
export const isFounderRole = (roleName?: string | null): boolean =>
  normalizeRole(roleName) === "founder";

export const isStoreManagerRole = (roleName?: string | null): boolean =>
  ["store manager", "store-manager", "storemanager"].includes(normalizeRole(roleName));

export const isEditorRole = (roleName?: string | null): boolean =>
  normalizeRole(roleName) === "editor";

/**
 * Whether a Founder may access the given super-admin pathname.
 * Returns true for any path not matching a forbidden prefix.
 */
export const canFounderAccessPath = (pathname?: string | null): boolean => {
  if (!pathname) return true;
  return !FOUNDER_FORBIDDEN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

export const canStoreManagerAccessPath = (pathname?: string | null): boolean => {
  if (!pathname) return true;
  return !STORE_MANAGER_FORBIDDEN_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

export const canEditorAccessPath = (pathname?: string | null): boolean => {
  if (!pathname) return true;
  return EDITOR_ALLOWED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
};

export const getRoleAdminLandingPath = (roleName?: string | null): string =>
  isEditorRole(roleName) ? "/blog" : "/";

export const canRoleAccessPath = (roleName?: string | null, pathname?: string | null): boolean => {
  if (isFounderRole(roleName)) return canFounderAccessPath(pathname);
  if (isStoreManagerRole(roleName)) return canStoreManagerAccessPath(pathname);
  if (isEditorRole(roleName)) return canEditorAccessPath(pathname);
  return true;
};
