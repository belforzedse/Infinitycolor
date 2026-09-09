const mockWriteAuditEvent = jest.fn().mockResolvedValue(undefined);

jest.mock("../../../audit/writer", () => ({
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

import { ADMIN_ROLE_DEFINITIONS, ADMIN_ROLE_IDS } from "@repo/auth-core";
import { requireCapability } from "../../../utils/adminAuthorization";

describe("model application direct API authorization", () => {
  beforeEach(() => jest.clearAllMocks());

  it.each(ADMIN_ROLE_IDS)("enforces the application capability for %s", async (role) => {
    const definition = ADMIN_ROLE_DEFINITIONS[role];
    const persistedUser = {
      id: 71,
      blocked: false,
      IsActive: true,
      role: { id: 9, type: definition.strapiType, name: definition.strapiName },
    };
    const strapi = {
      query: jest.fn(() => ({ findOne: jest.fn().mockResolvedValue(persistedUser) })),
      log: { error: jest.fn() },
    };
    const ctx = {
      state: { user: { id: 71 } },
      request: { path: "/api/model-applications/admin", method: "GET" },
      forbidden: jest.fn(),
      unauthorized: jest.fn(),
    };

    const actor = await requireCapability(ctx, strapi, "system.modelApplications.manage");

    if (role === "superadmin" || role === "founder") {
      expect(actor).toEqual(expect.objectContaining({ role }));
      expect(ctx.forbidden).not.toHaveBeenCalled();
    } else {
      expect(actor).toBeNull();
      expect(ctx.forbidden).toHaveBeenCalledWith(
        "You do not have permission to perform this action",
      );
    }
  });
});
