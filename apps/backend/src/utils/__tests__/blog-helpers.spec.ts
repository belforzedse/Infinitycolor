import { resolveUserDisplayName } from "../blog-helpers";

describe("resolveUserDisplayName", () => {
  it("prefers the profile name", () => {
    expect(
      resolveUserDisplayName({
        username: "+989121234567",
        user_info: { FirstName: "سارا", LastName: "محمدی" },
      }),
    ).toBe("سارا محمدی");
  });

  it("falls back to phone when username is empty", () => {
    expect(resolveUserDisplayName({ phone: "+989121234567" })).toBe("+989121234567");
  });

  it("still uses username before the anonymous label", () => {
    expect(resolveUserDisplayName({ username: "+989121234567" })).toBe("+989121234567");
  });
});
