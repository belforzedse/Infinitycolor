const migrationMiddleware = ["api::wordpress-migration.verify-control"];

export default {
  routes: [
    {
      method: "GET",
      path: "/internal/migrations/wordpress-v2/snapshot",
      handler: "wordpress-migration.snapshot",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/users/upsert",
      handler: "wordpress-migration.upsertUser",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/wallets/upsert",
      handler: "wordpress-migration.upsertWallet",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/orders/upsert",
      handler: "wordpress-migration.upsertOrder",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/media/timestamps",
      handler: "wordpress-migration.restoreMediaTimestamps",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/category-editorial/prepare",
      handler: "wordpress-migration.prepareCategoryEditorial",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
    {
      method: "POST",
      path: "/internal/migrations/wordpress-v2/category-editorial/finalize",
      handler: "wordpress-migration.finalizeCategoryEditorial",
      config: { auth: { scope: [] }, policies: [], middlewares: migrationMiddleware },
    },
  ],
};
