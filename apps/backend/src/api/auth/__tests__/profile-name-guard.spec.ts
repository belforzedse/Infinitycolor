import { normalizeRequiredProfileName } from "../utils/profile-names";

describe("profile name completion guard", () => {
  it("rejects missing, non-string, empty, and whitespace-only names", () => {
    for (const value of [undefined, null, 42, "", "   ", "\t\n"]) {
      expect(normalizeRequiredProfileName(value)).toBeNull();
    }
  });

  it("trims and preserves a real name", () => {
    expect(normalizeRequiredProfileName("  نیما  ")).toBe("نیما");
  });
});
