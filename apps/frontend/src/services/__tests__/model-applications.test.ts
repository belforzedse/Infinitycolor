import { submitModelApplication } from "../model-applications";

jest.mock("@/lib/central-auth", () => ({
  centralAuth: {
    tokenManager: {
      getToken: jest.fn(),
    },
  },
}));

jest.mock("@repo/api", () => ({
  getStrapiServerUrl: () => "http://localhost:1337/api",
}));

const mockedCentralAuth = jest.requireMock("@/lib/central-auth") as {
  centralAuth: { tokenManager: { getToken: jest.Mock } };
};

describe("submitModelApplication", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockReset();
  });

  it("submits as a guest without an Authorization header", async () => {
    mockedCentralAuth.centralAuth.tokenManager.getToken.mockRejectedValue(
      new Error("no session"),
    );
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          applicationId: "11111111-1111-4111-8111-111111111111",
          createdAt: "2026-09-09T12:00:00.000Z",
          replayed: false,
        },
      }),
    });

    const formData = new FormData();
    formData.append("fullName", "علی رضایی");
    const result = await submitModelApplication(formData);

    expect(result.applicationId).toBe("11111111-1111-4111-8111-111111111111");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:1337/api/model-applications",
      expect.objectContaining({
        method: "POST",
        body: formData,
      }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });
});
