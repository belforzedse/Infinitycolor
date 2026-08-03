import {
  getTrustedWordPressMigrationSourceTimestamps,
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

  it("accepts canonical source timestamps only on a trusted request", () => {
    process.env.MIGRATION_CONTROL_TOKEN = "t".repeat(48);
    (global as any).strapi = {
      requestContext: {
        get: () => ({
          request: {
            headers: {
              "x-infinity-migration-mode": WORDPRESS_MIGRATION_MODE,
              "x-infinity-migration-control": "t".repeat(48),
              "x-infinity-source-created-at": "2020-01-02T03:04:05.000Z",
              "x-infinity-source-updated-at": "2024-05-06T07:08:09.000Z",
            },
          },
        }),
      },
    };

    expect(getTrustedWordPressMigrationSourceTimestamps()).toEqual({
      createdAt: new Date("2020-01-02T03:04:05.000Z"),
      updatedAt: new Date("2024-05-06T07:08:09.000Z"),
    });
  });

  it("rejects partial or non-canonical trusted timestamp headers", () => {
    process.env.MIGRATION_CONTROL_TOKEN = "t".repeat(48);
    const headers: Record<string, string> = {
      "x-infinity-migration-mode": WORDPRESS_MIGRATION_MODE,
      "x-infinity-migration-control": "t".repeat(48),
      "x-infinity-source-created-at": "2020-01-02T03:04:05.000Z",
    };
    (global as any).strapi = {
      requestContext: { get: () => ({ request: { headers } }) },
    };
    expect(() => getTrustedWordPressMigrationSourceTimestamps()).toThrow(
      "MIGRATION_SOURCE_TIMESTAMPS_INCOMPLETE",
    );
    headers["x-infinity-source-updated-at"] = "2024-05-06T07:08:09Z";
    expect(() => getTrustedWordPressMigrationSourceTimestamps()).toThrow(
      "MIGRATION_SOURCE_UPDATED_AT_INVALID",
    );
  });
});
