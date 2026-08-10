const putMock = jest.fn();

jest.mock("@/lib/api-client", () => ({
  apiClient: {
    put: (...args: unknown[]) => putMock(...args),
  },
}));

import { updateAdminUser } from "../update";

describe("updateAdminUser", () => {
  beforeEach(() => {
    putMock.mockReset().mockResolvedValue({});
  });

  it("persists the canonical role after privileged profile writes", async () => {
    await updateAdminUser({
      id: "7",
      profile: { firstName: "Yazdan", lastName: "Naderi" },
      user: { role: 4, IsActive: true },
    });

    expect(putMock.mock.calls).toEqual([
      [
        "/sp/local-users/7",
        { firstName: "Yazdan", lastName: "Naderi" },
        { suppressAuthRedirect: true },
      ],
      ["/users/7", { role: 4, IsActive: true }, { suppressAuthRedirect: true }],
    ]);
  });

  it("does not attempt the role write when the profile write fails", async () => {
    putMock.mockRejectedValueOnce(new Error("profile failed"));

    await expect(
      updateAdminUser({
        id: "7",
        profile: {},
        user: { role: 4, IsActive: true },
      }),
    ).rejects.toThrow("profile failed");

    expect(putMock).toHaveBeenCalledTimes(1);
  });
});
