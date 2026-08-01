import { clearAccessToken, setAccessToken } from "../accessToken";

describe("storefront access token boundary", () => {
  const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204 });

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockClear();
    global.fetch = fetchMock;
  });

  it("fails closed instead of persisting a reusable token", () => {
    expect(() => setAccessToken("test-token")).toThrow(
      "Reusable auth credentials may not be persisted",
    );
    expect(localStorage.getItem("accessToken")).toBeNull();
  });

  it("invalidates in-memory auth state and asks the server to clear its HttpOnly hint", () => {
    clearAccessToken();

    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/route-hint",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });
});
