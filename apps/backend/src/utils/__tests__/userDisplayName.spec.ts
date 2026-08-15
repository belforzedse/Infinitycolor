import { resolveUserFullName } from "../userDisplayName";

describe("resolveUserFullName", () => {
  it("builds a trimmed profile name without falling back to the phone username", () => {
    expect(
      resolveUserFullName({
        username: "+989121234567",
        user_info: { FirstName: " سارا ", LastName: " محمدی " },
      }),
    ).toBe("سارا محمدی");
  });

  it("supports database-style profile field names", () => {
    expect(
      resolveUserFullName({
        user_info: { first_name: "علی", last_name: "رضایی" },
      }),
    ).toBe("علی رضایی");
  });

  it("does not treat a login identifier as a human name", () => {
    expect(resolveUserFullName({ username: "+989121234567" })).toBeNull();
  });
});
