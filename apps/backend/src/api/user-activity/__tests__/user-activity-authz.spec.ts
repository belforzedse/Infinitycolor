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

  it.each(["Store Manager", "Founder"])(
    "keeps %s scoped when the controller has not granted system user access",
    async () => {
      await expect(
        (userActivityService as any).findUserActivitiesByUserId(20, 10, false),
      ).rejects.toThrow("You can only view your own activities");

      expect(mockFindMany).not.toHaveBeenCalled();
    },
  );

  it("allows a capability-authorized caller to inspect another user's activity stream", async () => {
    await expect(
      (userActivityService as any).findUserActivitiesByUserId(20, 10, true),
    ).resolves.toEqual([]);

    expect(mockFindMany).toHaveBeenCalledWith(
      "api::user-activity.user-activity",
      expect.objectContaining({ filters: { user: { id: 20 } } }),
    );
  });
});
