export const ADMIN_CAPABILITIES = [
  "account.self.read",
  "account.self.update",
  "account.password.update",
  "account.sessions.manage",
  "storefront.checkout.use",
  "storefront.orders.read-own",
  "storefront.wallet.read-own",
  "content.blog.read",
  "content.blog.create",
  "content.blog.update",
  "content.blog.publish",
  "content.blog.delete",
  "content.blog.taxonomy.manage",
  "content.blog.comments.manage",
  "content.blog.banners.manage",
  "content.stories.manage",
  "content.faq.manage",
  "content.categoryEditorial.manage",
  "product.read",
  "product.create",
  "product.update",
  "product.duplicate",
  "product.publish",
  "product.schedule",
  "product.stock.update",
  "product.media.manage",
  "product.homepage.manage",
  "product.variation.manage",
  "product.variation.delete",
  "product.size-guide.manage",
  "product.size-guide.delete",
  // Reversible removal to the recycle bin (stamps `removedAt`). Distinct from
  // `product.delete`, which is permanent and stays Superadmin-only.
  "product.softDelete",
  "product.delete",
  "product.restore",
  "category.read",
  "category.create",
  "category.update",
  "category.delete",
  "order.read",
  "order.financial.read",
  "order.status.update",
  "order.notes.update",
  "order.address.update",
  "order.items.adjust",
  "order.cancel",
  "order.manual.create",
  "order.shipping.manage",
  "order.bulk.update",
  "order.audit.read",
  "order.print",
  "report.product.read",
  "report.sales.read",
  "report.finance.read",
  "report.carts.read",
  "report.traffic.read",
  "wallet.customer.search",
  "wallet.read",
  "wallet.history.read",
  "wallet.adjust",
  "system.users.manage",
  "system.roles.manage",
  "system.settings.manage",
  "system.audit.read",
  "system.audit.export",
  "system.purge.execute",
  "system.customization.manage",
  "system.discounts.manage",
  "system.shipping.manage",
  "system.payments.manage",
  "system.reviews.manage",
  "system.issueReports.manage",
  "system.modelApplications.manage",
] as const;

export type AdminCapability = (typeof ADMIN_CAPABILITIES)[number];

export const ADMIN_ROLE_IDS = [
  "support",
  "editor",
  "seller1",
  "seller2",
  "store_manager",
  "store_manager_2",
  "finance",
  "founder",
  "superadmin",
] as const;

export type AdminRoleId = (typeof ADMIN_ROLE_IDS)[number];

export type AdminRoleDefinition = Readonly<{
  id: AdminRoleId;
  englishLabel: string;
  persianLabel: string;
  strapiType: string;
  strapiName: string;
  inherits: readonly AdminRoleId[];
  capabilities: readonly AdminCapability[];
  allCapabilities?: boolean;
}>;

const ACCOUNT_SELF_CAPABILITIES = [
  "account.self.read",
  "account.self.update",
  "account.password.update",
  "account.sessions.manage",
] as const satisfies readonly AdminCapability[];

const CUSTOMER_STOREFRONT_CAPABILITIES = [
  "storefront.checkout.use",
  "storefront.orders.read-own",
  "storefront.wallet.read-own",
] as const satisfies readonly AdminCapability[];

export const ADMIN_ROLE_DEFINITIONS: Readonly<
  Record<AdminRoleId, AdminRoleDefinition>
> = {
  support: {
    id: "support",
    englishLabel: "Support",
    persianLabel: "پشتیبان",
    strapiType: "support",
    strapiName: "Support",
    inherits: [],
    // Customer-facing moderation only: product reviews and the issue-report
    // inbox. Deliberately no catalog, order, wallet, or reporting access.
    capabilities: [
      ...ACCOUNT_SELF_CAPABILITIES,
      ...CUSTOMER_STOREFRONT_CAPABILITIES,
      "system.reviews.manage",
      "system.issueReports.manage",
    ],
  },
  editor: {
    id: "editor",
    englishLabel: "Editor",
    persianLabel: "ویرایشگر",
    strapiType: "editor",
    strapiName: "Editor",
    inherits: [],
    capabilities: [
      ...ACCOUNT_SELF_CAPABILITIES,
      ...CUSTOMER_STOREFRONT_CAPABILITIES,
      "content.blog.read",
      "content.blog.create",
      "content.blog.update",
      "content.blog.publish",
      "content.blog.delete",
      "content.blog.taxonomy.manage",
      "content.blog.comments.manage",
      "content.blog.banners.manage",
      "content.categoryEditorial.manage",
      "content.stories.manage",
    ],
  },
  seller1: {
    id: "seller1",
    englishLabel: "Seller 1",
    persianLabel: "فروشنده ۱",
    strapiType: "seller-1",
    strapiName: "Seller 1",
    inherits: [],
    capabilities: [
      ...ACCOUNT_SELF_CAPABILITIES,
      ...CUSTOMER_STOREFRONT_CAPABILITIES,
      "product.read",
      "product.create",
      "product.update",
      "product.duplicate",
      "product.publish",
      "product.stock.update",
      "product.media.manage",
      "product.variation.manage",
      "product.variation.delete",
      "product.size-guide.manage",
      // Reversible pair: a seller who removes a product by mistake can put it
      // back themselves. Permanent deletion remains Superadmin-only.
      "product.softDelete",
      "product.restore",
    ],
  },
  seller2: {
    id: "seller2",
    englishLabel: "Seller 2",
    persianLabel: "فروشنده ۲",
    strapiType: "seller-2",
    strapiName: "Seller 2",
    inherits: ["seller1"],
    capabilities: [
      "product.schedule",
      "product.homepage.manage",
      "category.read",
      "category.create",
      "category.update",
      "order.read",
      "order.status.update",
      "order.notes.update",
      "order.address.update",
      "order.cancel",
      "content.stories.manage",
    ],
  },
  store_manager: {
    id: "store_manager",
    englishLabel: "Store Manager",
    persianLabel: "مدیر فروشگاه",
    strapiType: "store-manager",
    strapiName: "Store Manager",
    inherits: ["seller2"],
    // No unique capabilities today: same operational surface as Seller 2.
    // Analytics stay on Finance+. Order cancel starts at Seller 2.
    capabilities: [],
  },
  store_manager_2: {
    id: "store_manager_2",
    englishLabel: "Store Manager 2",
    persianLabel: "مدیر فروشگاه ۲",
    strapiType: "store-manager-2",
    strapiName: "Store Manager 2",
    inherits: ["store_manager"],
    capabilities: [
      "wallet.customer.search",
      "wallet.read",
      "wallet.history.read",
      "wallet.adjust",
    ],
  },
  finance: {
    id: "finance",
    englishLabel: "Finance",
    persianLabel: "مالی",
    strapiType: "finance",
    strapiName: "Finance",
    inherits: ["seller2"],
    capabilities: [
      "order.financial.read",
      "report.product.read",
      "report.sales.read",
      "report.finance.read",
      "report.carts.read",
      "wallet.customer.search",
      "wallet.read",
      "wallet.history.read",
      "wallet.adjust",
    ],
  },
  founder: {
    id: "founder",
    englishLabel: "Founder",
    persianLabel: "بنیان‌گذار",
    strapiType: "founder",
    strapiName: "Founder",
    inherits: ["store_manager", "finance"],
    capabilities: [
      "report.traffic.read",
      "wallet.customer.search",
      "wallet.read",
      "wallet.history.read",
      "wallet.adjust",
      "order.manual.create",
      "system.modelApplications.manage",
      "category.delete",
    ],
  },
  superadmin: {
    id: "superadmin",
    englishLabel: "Superadmin",
    persianLabel: "مدیر ارشد",
    strapiType: "superadmin",
    strapiName: "Superadmin",
    inherits: ["founder"],
    capabilities: [],
    allCapabilities: true,
  },
};

const compactRoleKey = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");

const ROLE_ALIASES: Readonly<Record<string, AdminRoleId>> = {
  support: "support",
  editor: "editor",
  seller1: "seller1",
  seller2: "seller2",
  storemanager: "store_manager",
  storemanager2: "store_manager_2",
  finance: "finance",
  founder: "founder",
  founders: "founder",
  superadmin: "superadmin",
};

export function isAdminRoleId(value: unknown): value is AdminRoleId {
  return (
    typeof value === "string" &&
    (ADMIN_ROLE_IDS as readonly string[]).includes(value)
  );
}

export function isAdminCapability(value: unknown): value is AdminCapability {
  return (
    typeof value === "string" &&
    (ADMIN_CAPABILITIES as readonly string[]).includes(value)
  );
}

export function normalizeAdminRole(value?: unknown): AdminRoleId | null {
  if (typeof value !== "string" || !value.trim()) return null;
  if (isAdminRoleId(value.trim())) return value.trim() as AdminRoleId;
  return ROLE_ALIASES[compactRoleKey(value)] ?? null;
}

function collectRoleCapabilities(
  role: AdminRoleId,
  target: Set<AdminCapability>,
  visiting: Set<AdminRoleId>,
): void {
  if (visiting.has(role)) {
    throw new Error(`Admin role inheritance cycle detected at ${role}`);
  }
  const definition = ADMIN_ROLE_DEFINITIONS[role];
  if (definition.allCapabilities) {
    ADMIN_CAPABILITIES.forEach((capability) => target.add(capability));
    return;
  }
  visiting.add(role);
  definition.inherits.forEach((parent) =>
    collectRoleCapabilities(parent, target, visiting),
  );
  definition.capabilities.forEach((capability) => target.add(capability));
  visiting.delete(role);
}

const ROLE_CAPABILITY_CACHE = Object.fromEntries(
  ADMIN_ROLE_IDS.map((role) => {
    const capabilities = new Set<AdminCapability>();
    collectRoleCapabilities(role, capabilities, new Set());
    return [role, Object.freeze([...capabilities])];
  }),
) as Record<AdminRoleId, readonly AdminCapability[]>;

export function capabilitiesForRole(
  role: AdminRoleId | string | null | undefined,
): readonly AdminCapability[] {
  const normalized = normalizeAdminRole(role);
  return normalized ? ROLE_CAPABILITY_CACHE[normalized] : [];
}

export function hasCapability(
  role: AdminRoleId | string | null | undefined,
  capability: AdminCapability,
): boolean {
  return capabilitiesForRole(role).includes(capability);
}

export function adminRoleLabel(
  role: AdminRoleId | string | null | undefined,
  locale: "en" | "fa" = "fa",
): string | null {
  const normalized = normalizeAdminRole(role);
  if (!normalized) return null;
  const definition = ADMIN_ROLE_DEFINITIONS[normalized];
  return locale === "en" ? definition.englishLabel : definition.persianLabel;
}
