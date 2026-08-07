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
]);

/**
 * Sales-hub children hidden from Founders. Carts, traffic and the staff
 * activity log were all Superadmin-only before the hub existed; nesting them
 * under /sales must not widen who can see them.
 */
export const FOUNDER_HIDDEN_CHILD_IDS = new Set<string>([
  "sales-traffic",
  "sales-carts",
  "sales-liquidity",
  "sales-gateways",
]);

/**
 * Route prefixes a Founder must NOT open (even by typing the URL).
 *
 * The legacy `/reports/*` and `/carts` entries are kept alongside their
 * `/sales/*` replacements: `next.config.ts` redirects the old paths, and the
 * guard evaluates the requested path before the redirect resolves.
 *
 * Note: `/sales/products` is intentionally NOT here — it is the single sales
 * report Founders are allowed to view under «گزارشات فروش».
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
  "/sales/traffic",
  "/sales/carts",
  "/sales/liquidity",
  "/sales/gateways",
  // Legacy paths, retained so bookmarks stay blocked before redirecting.
  "/reports/traffic",
  "/reports/admin-activity",
  "/reports/liquidity",
  "/reports/gateway-liquidity",
];

export const STORE_MANAGER_HIDDEN_PARENT_IDS = new Set<string>([
  "customization",
  "blog",
  "faq",
  "stories",
  "users",
  "settings",
  "sales",
  "payment-methods",
]);

export const STORE_MANAGER_HIDDEN_CHILD_IDS = new Set<string>([
  "homepage-products",
  "homepage-gif-promo-products",
  "homepage-custom-section",
  "shipping-provinces",
  "shipping-cities",
]);

export const STORE_MANAGER_FORBIDDEN_PREFIXES: string[] = [
  "/customization",
  "/blog",
  "/faq",
  "/stories",
  "/users",
  "/settings",
  // Denies the whole Sales hub, mirroring the previous "/reports" + "/carts"
  // denial. The staff activity log moved under /settings, already denied here.
  "/sales",
  "/payment-methods",
  "/purgeall",
  "/orders/add",
  "/products/homepage",
  "/products/gif-promo",
  "/products/homepage-custom-section",
  "/shipping/provinces",
  // Legacy paths, retained so bookmarks stay blocked before redirecting.
  "/reports",
  "/carts",
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
