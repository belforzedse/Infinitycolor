import type { Strapi } from "@strapi/strapi";

type StrapiFactory = {
  (options?: Record<string, unknown>): Strapi & {
    load?: () => Promise<Strapi>;
    destroy?: () => Promise<void>;
  };
  compile?: () => Promise<Record<string, unknown>>;
};

export async function createLoadedStrapi(): Promise<Strapi> {
  const createStrapi = require("@strapi/strapi") as StrapiFactory;
  const appContext =
    process.env.NODE_ENV === "production"
      ? { distDir: "./dist" }
      : await createStrapi.compile?.();

  const app = createStrapi(appContext || {});
  if (typeof app.load !== "function") {
    throw new Error("Strapi worker requires @strapi/strapi app.load()");
  }

  try {
    await app.load();
    return app;
  } catch (error) {
    await app.destroy?.().catch(() => undefined);
    throw error;
  }
}
