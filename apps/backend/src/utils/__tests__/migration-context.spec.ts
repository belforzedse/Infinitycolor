import {
  isTrustedWordPressMigrationRequest,
  WORDPRESS_MIGRATION_MODE,
} from "../migration-context";

describe("migration request context", () => {
  const previousToken = process.env.MIGRATION_CONTROL_TOKEN;

  afterEach(() => {
    if (previousToken === undefined) delete process.env.MIGRATION_CONTROL_TOKEN;
    else process.env.MIGRATION_CONTROL_TOKEN = previousToken;
    delete (global as any).strapi;
  });

  it("requires both the mode and the separate control token", () => {
    process.env.MIGRATION_CONTROL_TOKEN = "a".repeat(48);
    (global as any).strapi = {
      requestContext: {
        get: () => ({
          request: {
            headers: {
              "x-infinity-migration-mode": WORDPRESS_MIGRATION_MODE,
              "x-infinity-migration-control": "a".repeat(48),
            },
          },
        }),
      },
    };

    expect(isTrustedWordPressMigrationRequest()).toBe(true);
  });

  it("fails closed for a missing, short, or mismatched control token", () => {
    process.env.MIGRATION_CONTROL_TOKEN = "too-short";
    (global as any).strapi = {
      requestContext: {
        get: () => ({
          request: {
            headers: {
              "x-infinity-migration-mode": WORDPRESS_MIGRATION_MODE,
              "x-infinity-migration-control": "too-short",
            },
          },
        }),
      },
    };
    expect(isTrustedWordPressMigrationRequest()).toBe(false);

    process.env.MIGRATION_CONTROL_TOKEN = "a".repeat(48);
    expect(isTrustedWordPressMigrationRequest()).toBe(false);
  });
});
