import {
  expect,
  test,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";
import {
  authCredentials,
  authStorageStatePath,
  type E2EAuthRole,
} from "../../helpers/auth";
import {
  apiGet,
  apiPost,
  expectApiForbidden,
  expectApiOk,
} from "../../helpers/api";

const CUSTOMER_CAPABILITIES = [
  "storefront.checkout.use",
  "storefront.orders.read-own",
  "storefront.wallet.read-own",
] as const;

type StaffRoleCase = {
  authRole: Extract<
    E2EAuthRole,
    | "editor"
    | "seller-1"
    | "seller-2"
    | "store-manager"
    | "store-manager-2"
    | "finance"
    | "founder"
    | "admin"
  >;
  adminRole: string;
  label: string;
  sidebarCount: number;
  visibleSidebarIds: string[];
  hiddenSidebarIds: string[];
  requiredCapabilities: string[];
  absentCapabilities: string[];
  forbiddenPath?: string;
  allowedApi?: (
    request: APIRequestContext,
    role: E2EAuthRole,
  ) => Promise<APIResponse>;
  forbiddenApi?: (
    request: APIRequestContext,
    role: E2EAuthRole,
  ) => Promise<APIResponse>;
};

const STAFF_ROLES: StaffRoleCase[] = [
  {
    authRole: "editor",
    adminRole: "editor",
    label: "Editor",
    sidebarCount: 11,
    visibleSidebarIds: [
      "blog-dashboard",
      "blog-posts",
      "blog-category-editorial",
      "blog-comments",
      "stories-list",
    ],
    hiddenSidebarIds: ["blog", "stories", "manage-products", "orders", "sales"],
    requiredCapabilities: ["content.blog.read", "content.blog.publish", "content.stories.manage"],
    absentCapabilities: [
      "content.faq.manage",
      "product.read",
    ],
    forbiddenPath: "/products",
    forbiddenApi: (request, role) =>
      apiPost(request, role, "/admin/products-list/query", {
        page: 1,
        pageSize: 1,
        removed: false,
        sort: "last-edited",
        filters: [],
      }),
  },
  {
    authRole: "seller-1",
    adminRole: "seller1",
    label: "Seller 1",
    sidebarCount: 3,
    visibleSidebarIds: ["products", "product-tags"],
    hiddenSidebarIds: [
      "manage-products",
      "product-categories",
      "product-colors",
      "product-attributes",
      "product-size-guide",
      "orders",
      "sales",
      "stories",
    ],
    requiredCapabilities: [
      "product.read",
      "product.publish",
      "product.variation.manage",
    ],
    absentCapabilities: [
      "product.schedule",
      "product.homepage.manage",
      "product.delete",
      "order.read",
      "order.cancel",
      "content.stories.manage",
    ],
    forbiddenPath: "/orders",
    allowedApi: (request, role) =>
      apiPost(request, role, "/admin/products-list/query", {
        page: 1,
        pageSize: 1,
        removed: false,
        sort: "last-edited",
        filters: [],
      }),
    forbiddenApi: (request, role) =>
      apiPost(request, role, "/admin/orders-list/query", {
        page: 1,
        pageSize: 1,
        tab: "all",
        sort: "last-edited",
        filters: [],
      }),
  },
  {
    authRole: "seller-2",
    adminRole: "seller2",
    label: "Seller 2",
    sidebarCount: 9,
    visibleSidebarIds: [
      "products",
      "homepage-products",
      "homepage-gif-promo-products",
      "homepage-custom-section",
      "product-categories",
      "orders",
      "stories",
    ],
    hiddenSidebarIds: [
      "manage-products",
      "product-colors",
      "product-attributes",
      "product-size-guide",
      "sales",
      "sales-products",
      "wallets",
    ],
    requiredCapabilities: [
      "product.read",
      "product.schedule",
      "product.homepage.manage",
      "category.update",
      "order.read",
      "order.status.update",
      "order.notes.update",
      "order.cancel",
      "content.stories.manage",
    ],
    absentCapabilities: [
      "report.product.read",
      "wallet.adjust",
      "category.delete",
    ],
    forbiddenPath: "/sales",
    allowedApi: (request, role) =>
      apiPost(request, role, "/admin/products-list/query", {
        page: 1,
        pageSize: 1,
        removed: false,
        sort: "last-edited",
        filters: [],
      }),
    forbiddenApi: (request, role) =>
      apiGet(request, role, "/reports/product-sales"),
  },
  {
    authRole: "store-manager",
    adminRole: "store_manager",
    label: "Store Manager",
    sidebarCount: 9,
    visibleSidebarIds: [
      "products",
      "homepage-products",
      "homepage-gif-promo-products",
      "homepage-custom-section",
      "product-categories",
      "orders",
      "stories",
    ],
    hiddenSidebarIds: [
      "manage-products",
      "product-colors",
      "product-attributes",
      "product-size-guide",
      "sales",
      "sales-products",
      "wallets",
    ],
    requiredCapabilities: [
      "product.schedule",
      "product.homepage.manage",
      "order.status.update",
      "order.notes.update",
      "order.cancel",
      "content.stories.manage",
    ],
    absentCapabilities: [
      "report.product.read",
      "order.manual.create",
      "report.finance.read",
    ],
    forbiddenPath: "/sales",
    allowedApi: (request, role) =>
      apiPost(request, role, "/admin/orders-list/query", {
        page: 1,
        pageSize: 1,
        tab: "all",
        sort: "last-edited",
        filters: [],
      }),
    forbiddenApi: (request, role) =>
      apiGet(request, role, "/reports/product-sales"),
  },
  {
    authRole: "store-manager-2",
    adminRole: "store_manager_2",
    label: "Store Manager 2",
    sidebarCount: 10,
    visibleSidebarIds: [
      "products",
      "homepage-products",
      "homepage-gif-promo-products",
      "homepage-custom-section",
      "product-categories",
      "orders",
      "wallets",
      "stories",
    ],
    hiddenSidebarIds: [
      "manage-products",
      "product-colors",
      "product-attributes",
      "product-size-guide",
      "sales",
      "users",
      "settings",
    ],
    requiredCapabilities: [
      "order.status.update",
      "order.notes.update",
      "order.cancel",
      "product.schedule",
      "product.homepage.manage",
      "wallet.customer.search",
      "wallet.read",
      "wallet.history.read",
      "wallet.adjust",
      "content.stories.manage",
    ],
    absentCapabilities: [
      "report.product.read",
      "order.manual.create",
      "report.finance.read",
      "system.users.manage",
      "system.roles.manage",
      "system.audit.read",
      "system.settings.manage",
      "system.payments.manage",
      "system.purge.execute",
      "product.delete",
    ],
    forbiddenPath: "/sales",
    allowedApi: (request, role) =>
      apiGet(
        request,
        role,
        `/sp/customers/search?q=${encodeURIComponent(
          authCredentials("customer").phone.slice(-7),
        )}&pageSize=3`,
      ),
    forbiddenApi: (request, role) =>
      apiGet(request, role, "/reports/product-sales"),
  },
  {
    authRole: "finance",
    adminRole: "finance",
    label: "Finance",
    sidebarCount: 6,
    visibleSidebarIds: ["manage-products", "orders", "sales", "wallets", "stories"],
    hiddenSidebarIds: ["sales-products", "settings"],
    requiredCapabilities: [
      "order.financial.read",
      "order.cancel",
      "product.schedule",
      "product.homepage.manage",
      "report.finance.read",
      "report.carts.read",
      "wallet.customer.search",
      "wallet.read",
      "wallet.history.read",
      "wallet.adjust",
      "content.stories.manage",
    ],
    absentCapabilities: [
      "report.traffic.read",
      "system.users.manage",
    ],
    forbiddenPath: "/sales/traffic",
    allowedApi: (request, role) => apiGet(request, role, "/reports/liquidity"),
    forbiddenApi: (request, role) =>
      apiGet(request, role, "/reports/traffic/dashboard"),
  },
  {
    authRole: "founder",
    adminRole: "founder",
    label: "Founder",
    sidebarCount: 7,
    visibleSidebarIds: [
      "manage-products",
      "orders",
      "wallets",
      "sales",
      "stories",
      "model-applications",
    ],
    hiddenSidebarIds: ["users", "settings", "store-operations"],
    requiredCapabilities: [
      "order.status.update",
      "order.financial.read",
      "order.cancel",
      "product.schedule",
      "product.homepage.manage",
      "order.manual.create",
      "report.traffic.read",
      "wallet.adjust",
      "content.stories.manage",
      "system.modelApplications.manage",
      "category.delete",
    ],
    absentCapabilities: [
      "system.users.manage",
      "system.roles.manage",
      "system.audit.read",
    ],
    forbiddenPath: "/settings",
    allowedApi: (request, role) =>
      apiGet(request, role, "/reports/behavior/overview"),
    forbiddenApi: (request, role) => apiGet(request, role, "/users"),
  },
  {
    authRole: "admin",
    adminRole: "superadmin",
    label: "Superadmin",
    sidebarCount: 13,
    visibleSidebarIds: [
      "issue-reports",
      "manage-products",
      "blog",
      "stories",
      "store-operations",
      "customer-operations",
      "sales",
      "settings",
      "issue-reports",
      "model-applications",
    ],
    hiddenSidebarIds: ["payment-methods", "wallets", "users"],
    requiredCapabilities: [
      "order.manual.create",
      "product.schedule",
      "wallet.adjust",
      "system.users.manage",
      "system.roles.manage",
      "system.audit.read",
      "system.issueReports.manage",
      "system.modelApplications.manage",
    ],
    absentCapabilities: [],
  },
];

function visibleTopLevelItems(page: Page) {
  return page.locator('[data-testid="super-admin-sidebar-item"]:visible');
}

function visibleSidebarItem(page: Page, id: string) {
  return page
    .locator(
      `[data-testid="super-admin-sidebar-item"][data-sidebar-id="${id}"]:visible`,
    )
    .first();
}

async function readSelf(request: APIRequestContext, role: E2EAuthRole) {
  const response = await apiGet(request, role, "/auth/self");
  await expectApiOk(response, `${role} self`);
  return response.json() as Promise<{
    id: number;
    adminRole: string | null;
    capabilities: string[];
  }>;
}

async function expectCustomerInheritance(
  request: APIRequestContext,
  role: StaffRoleCase,
) {
  for (const [pathname, label] of [
    ["/carts/me", "cart"],
    ["/orders/my-orders", "own orders"],
    ["/local-user-wallet/me", "own wallet"],
  ] as const) {
    await expectApiOk(
      await apiGet(request, role.authRole, pathname),
      `${role.label} ${label}`,
    );
  }
}

for (const role of STAFF_ROLES) {
  test.describe(`${role.label} capability workspace`, () => {
    test.use({ storageState: authStorageStatePath(role.authRole) });

    test(`@permissions @smoke ${role.label} desktop navigation and backend capabilities`, async ({
      page,
      request,
    }) => {
      const self = await readSelf(request, role.authRole);
      expect(self.adminRole).toBe(role.adminRole);
      expect(self.capabilities).toEqual(
        expect.arrayContaining([
          ...CUSTOMER_CAPABILITIES,
          ...role.requiredCapabilities,
        ]),
      );
      for (const capability of role.absentCapabilities) {
        expect(self.capabilities).not.toContain(capability);
      }

      await expectCustomerInheritance(request, role);
      await expectApiOk(
        await apiPost(
          request,
          role.authRole,
          "/admin/dashboard-summary/query",
          {},
        ),
        `${role.label} dashboard summary`,
      );

      if (role.allowedApi) {
        await expectApiOk(
          await role.allowedApi(request, role.authRole),
          `${role.label} allowed API`,
        );
      }

      if (role.forbiddenApi) {
        await expectApiForbidden(
          await role.forbiddenApi(request, role.authRole),
        );
      } else {
        await expectApiOk(
          await apiGet(request, role.authRole, "/reports/admin-activity", {
            page: 1,
            pageSize: 1,
          }),
          "Superadmin audit report",
        );
      }

      await page.goto("/", { waitUntil: "domcontentloaded" });
      await expect(visibleTopLevelItems(page)).toHaveCount(role.sidebarCount, {
        timeout: 30_000,
      });
      for (const id of role.visibleSidebarIds) {
        await expect(visibleSidebarItem(page, id)).toBeVisible();
      }
      for (const id of role.hiddenSidebarIds) {
        await expect(visibleSidebarItem(page, id)).toHaveCount(0);
      }

      if (role.forbiddenPath) {
        await page.goto(role.forbiddenPath, { waitUntil: "domcontentloaded" });
        const forbiddenAlert = page
          .locator('section[role="alert"]')
          .filter({ hasText: "اجازه مشاهده این بخش را ندارید" });
        await expect(forbiddenAlert).toContainText(
          "اجازه مشاهده این بخش را ندارید",
          { timeout: 30_000 },
        );
        await expect(forbiddenAlert.getByRole("link")).toHaveAttribute("href");
      }
    });

    test(`@permissions ${role.label} mobile navigation remains balanced`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "باز کردن منوی مدیریت" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expect(visibleTopLevelItems(page)).toHaveCount(role.sidebarCount, {
        timeout: 30_000,
      });
      for (const id of role.visibleSidebarIds) {
        const item = visibleSidebarItem(page, id);
        await item.scrollIntoViewIfNeeded();
        await expect(item).toBeVisible();
      }
    });
  });
}

test.describe("Store Manager 2 wallet workflow", () => {
  test.use({ storageState: authStorageStatePath("store-manager-2") });

  test("@permissions searches, reads, adjusts, and reloads another customer wallet", async ({
    request,
  }) => {
    const customerPhone = authCredentials("customer").phone;
    const search = await apiGet(
      request,
      "store-manager-2",
      `/sp/customers/search?q=${encodeURIComponent(customerPhone.slice(-7))}&pageSize=3`,
    );
    await expectApiOk(search, "Store Manager 2 customer search");
    const searchBody = (await search.json()) as {
      data?: Array<{ id?: number; phone?: string | null }>;
    };
    const customer = searchBody.data?.find(
      (entry) => entry.phone === customerPhone,
    );
    expect(customer?.id).toBeTruthy();
    const customerId = Number(customer?.id);

    await expectApiOk(
      await apiGet(
        request,
        "store-manager-2",
        `/local-user-wallet/admin/${customerId}`,
      ),
      "Store Manager 2 wallet balance",
    );
    await expectApiOk(
      await apiGet(
        request,
        "store-manager-2",
        `/local-user-wallet/admin/${customerId}/history?page=1&pageSize=25`,
      ),
      "Store Manager 2 wallet history",
    );
    const adjustment = await apiPost(
      request,
      "store-manager-2",
      "/local-user-wallet/admin/adjust",
      {
        userId: customerId,
        mode: "credit",
        amountToman: 1,
        reason: "E2E Store Manager 2 wallet workflow",
      },
    );
    await expectApiOk(adjustment, "Store Manager 2 wallet adjustment");
    expect(await adjustment.json()).toEqual(
      expect.objectContaining({ success: true }),
    );
    await expectApiOk(
      await apiGet(
        request,
        "store-manager-2",
        `/local-user-wallet/admin/${customerId}/history?page=1&pageSize=25`,
      ),
      "Store Manager 2 refreshed wallet history",
    );
  });

  test("@permissions searches and credits a staff wallet", async ({ request }) => {
    const founderPhone = authCredentials("founder").phone;
    const search = await apiGet(
      request,
      "store-manager-2",
      `/sp/customers/search?q=${encodeURIComponent(founderPhone)}&pageSize=20`,
    );
    await expectApiOk(search, "Store Manager 2 staff wallet search");
    const searchBody = (await search.json()) as {
      data?: Array<{ id?: number; phone?: string | null }>;
    };
    const founder = searchBody.data?.find((entry) => entry.phone === founderPhone);
    expect(founder?.id).toBeTruthy();
    const founderId = Number(founder?.id);

    const adjustment = await apiPost(
      request,
      "store-manager-2",
      "/local-user-wallet/admin/adjust",
      {
        userId: founderId,
        mode: "credit",
        amountToman: 1,
        reason: "E2E Store Manager 2 staff wallet credit",
      },
    );
    await expectApiOk(adjustment, "Store Manager 2 staff wallet adjustment");
    expect(await adjustment.json()).toEqual(
      expect.objectContaining({ success: true }),
    );
  });
});

for (const authRole of ["store-manager-2", "finance", "founder", "admin"] as const) {
  test.describe(`${authRole} own-wallet administration boundary`, () => {
    test.use({ storageState: authStorageStatePath(authRole) });

    test(`@permissions ${authRole} cannot administratively credit its own wallet`, async ({
      request,
    }) => {
      const self = await readSelf(request, authRole);
      const response = await apiPost(
        request,
        authRole,
        "/local-user-wallet/admin/adjust",
        {
          userId: self.id,
          mode: "credit",
          amountToman: 1,
          reason: "E2E self-adjustment denial check",
        },
      );
      expect(response.status()).toBe(403);
      expect(await response.text()).toContain(
        "SELF_WALLET_ADJUSTMENT_FORBIDDEN",
      );
    });
  });
}
