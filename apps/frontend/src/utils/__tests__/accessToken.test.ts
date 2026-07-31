import { clearAccessToken, setAccessToken } from "../accessToken";
import { AUTH_ROUTE_HINT_COOKIE, AUTH_ROUTE_HINT_COOKIE_VALUE } from "../authRouteHint";

describe("storefront access token routing marker", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = `${AUTH_ROUTE_HINT_COOKIE}=; Path=/; Max-Age=0`;
  });

  it("sets the non-secret route marker when a token is stored", () => {
    setAccessToken("test-token");

    expect(localStorage.getItem("accessToken")).toBe("test-token");
    expect(document.cookie).toContain(
      `${AUTH_ROUTE_HINT_COOKIE}=${AUTH_ROUTE_HINT_COOKIE_VALUE}`,
    );
  });

  it("clears the route marker together with the token", () => {
    setAccessToken("test-token");
    clearAccessToken();

    expect(localStorage.getItem("accessToken")).toBeNull();
    expect(document.cookie).not.toContain(`${AUTH_ROUTE_HINT_COOKIE}=`);
  });
});
