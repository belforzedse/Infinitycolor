const mockFindMany = jest.fn();
const mockStrapi: any = {
  entityService: { findMany: mockFindMany },
};

jest.mock("@strapi/strapi", () => ({
  factories: {
    createCoreService: jest.fn((_uid, factory) => factory({ strapi: mockStrapi })),
  },
}));

import userActivityService from "../services/user-activity";

describe("user activity ownership", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindMany.mockResolvedValue([]);
  });

  it.each(["Store manager", "Founder"])(
    "keeps %s scoped to its own activity stream",
    async (roleName) => {
      await expect(
        (userActivityService as any).findUserActivitiesByUserId(20, 10, roleName),
      ).rejects.toThrow("You can only view your own activities");

      expect(mockFindMany).not.toHaveBeenCalled();
    },
  );

  it("allows Superadmin to inspect another user's activity stream", async () => {
    await expect(
      (userActivityService as any).findUserActivitiesByUserId(20, 10, "Superadmin"),
    ).resolves.toEqual([]);

    expect(mockFindMany).toHaveBeenCalledWith(
      "api::user-activity.user-activity",
      expect.objectContaining({ filters: { user: { id: 20 } } }),
    );
  });
});
