import type { Strapi } from "@strapi/strapi";
import path from "node:path";

export async function ensureCatalogEditStorage(strapi: Strapi): Promise<void> {
  // This module is shared with the pre-schema-sync migration. Keep database
  // objects installed after every sync, including the stock revision trigger.
  const storage = require(path.join(strapi.dirs.app.root, "database/catalog-edit-storage.js"));
  await storage.ensureCatalogEditStorage(strapi.db.connection);
}
