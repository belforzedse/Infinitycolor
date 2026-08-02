import blogCategoryLifecycles from "../lifecycles";
import { WORDPRESS_MIGRATION_MODE } from "../../../../../utils/migration-context";

describe("blog-category lifecycles", () => {
  const originalToken = process.env.MIGRATION_CONTROL_TOKEN;
  const originalFetch = global.fetch;

  beforeEach(() => {
    const controlToken = "m".repeat(48);
    process.env.MIGRATION_CONTROL_TOKEN = controlToken;
    global.fetch = jest.fn();
    (global as any).strapi = {
      requestContext: {
        get: () => ({
          request: {
            headers: {
              "x-infinity-migration-mode": WORDPRESS_MIGRATION_MODE,
              "x-infinity-migration-control": controlToken,
            },
          },
        }),
      },
      log: {
        error: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
      },
    };
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (global as any).strapi;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.MIGRATION_CONTROL_TOKEN;
    else process.env.MIGRATION_CONTROL_TOKEN = originalToken;
    global.fetch = originalFetch;
  });

  it("suppresses every revalidation hook for a trusted WordPress migration", async () => {
    await blogCategoryLifecycles.afterCreate();
    await blogCategoryLifecycles.afterUpdate();
    await blogCategoryLifecycles.afterDelete();

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
