const mockWriteAuditEvent = jest.fn().mockResolvedValue(undefined);
const mockTrusted = jest.fn(() => false);

jest.mock("../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));
jest.mock("../migration-context", () => ({
  isTrustedWordPressMigrationRequest: () => mockTrusted(),
}));

import { apiTokenAllowsCapability, requireCapability } from "../adminAuthorization";

const EDITORIAL_ACTIONS = [
  "api::product-category-content.product-category-content.targets",
  "api::product-category-content.product-category-content.editable",
  "api::product-category-content.product-category-content.upsert",
];

const STORY_ACTIONS = [
  "api::story.story.create",
  "api::story.story.update",
  "api::story.story.delete",
];

function makeStrapi() {
  return {
    query: jest.fn(),
    log: { error: jest.fn() },
  } as any;
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    state: {},
    request: { path: "/api/category-editorial/1", method: "PUT" },
    forbidden: jest.fn((message: string) => ({ message })),
    unauthorized: jest.fn((message: string) => ({ message })),
    ...overrides,
  } as any;
}

describe("requireCapability API tokens and trusted importer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockTrusted.mockReturnValue(false);
  });

  it("lets a trusted WordPress migration request through without a staff user", async () => {
    mockTrusted.mockReturnValue(true);
    const ctx = makeCtx();
    const actor = await requireCapability(ctx, makeStrapi(), "content.categoryEditorial.manage");
    expect(actor?.user.username).toBe("wordpress-migration");
    expect(ctx.unauthorized).not.toHaveBeenCalled();
    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("lets a full-access API token through capability-gated routes", async () => {
    const ctx = makeCtx({
      state: {
        auth: {
          strategy: { name: "api-token" },
          credentials: { id: 2, name: "import2", type: "full-access" },
        },
      },
    });
    const actor = await requireCapability(ctx, makeStrapi(), "content.categoryEditorial.manage");
    expect(actor?.user.username).toBe("import2");
    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("lets a custom API token through when it lists every mapped editorial action", async () => {
    const ctx = makeCtx({
      state: {
        auth: {
          strategy: { name: "api-token" },
          credentials: { id: 2, name: "import2", type: "custom", permissions: EDITORIAL_ACTIONS },
        },
      },
    });
    const actor = await requireCapability(ctx, makeStrapi(), "content.categoryEditorial.manage");
    expect(actor).not.toBeNull();
    expect(ctx.forbidden).not.toHaveBeenCalled();
  });

  it("rejects a custom API token that is missing an editorial action", async () => {
    const ctx = makeCtx({
      state: {
        auth: {
          strategy: { name: "api-token" },
          credentials: {
            id: 2,
            name: "import2",
            type: "custom",
            permissions: EDITORIAL_ACTIONS.slice(0, 2),
          },
        },
      },
    });
    const actor = await requireCapability(ctx, makeStrapi(), "content.categoryEditorial.manage");
    expect(actor).toBeNull();
    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("requires every story mutation action for a custom story-management token", () => {
    expect(
      apiTokenAllowsCapability(
        { type: "custom", permissions: STORY_ACTIONS },
        "content.stories.manage",
      ),
    ).toBe(true);
    expect(
      apiTokenAllowsCapability(
        { type: "custom", permissions: STORY_ACTIONS.slice(0, 2) },
        "content.stories.manage",
      ),
    ).toBe(false);
  });

  it("rejects a custom API token for capabilities with no token action map", async () => {
    expect(
      apiTokenAllowsCapability(
        { type: "custom", permissions: EDITORIAL_ACTIONS },
        "system.users.manage",
      ),
    ).toBe(false);
    const ctx = makeCtx({
      state: {
        auth: {
          strategy: { name: "api-token" },
          credentials: { id: 2, name: "import2", type: "custom", permissions: EDITORIAL_ACTIONS },
        },
      },
    });
    const actor = await requireCapability(ctx, makeStrapi(), "system.users.manage");
    expect(actor).toBeNull();
    expect(ctx.forbidden).toHaveBeenCalled();
  });

  it("still requires a staff user when no API token or trusted importer is present", async () => {
    const ctx = makeCtx();
    const actor = await requireCapability(ctx, makeStrapi(), "content.categoryEditorial.manage");
    expect(actor).toBeNull();
    expect(ctx.unauthorized).toHaveBeenCalledWith("Authentication required");
  });
});
