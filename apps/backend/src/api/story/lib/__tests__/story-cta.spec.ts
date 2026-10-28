import {
  applyStoryCtaMutation,
  normalizeStoryCtaUrl,
  STORY_CTA_LABEL,
  STORY_CTA_URL_MAX_LENGTH,
  StoryCtaValidationError,
} from "../story-cta";

describe("story CTA", () => {
  it.each([
    [" /pdp/example?color=blue#size ", "/pdp/example?color=blue#size"],
    ["https://example.com/collection?q=new", "https://example.com/collection?q=new"],
  ])("normalizes safe destination %s", (value, expected) => {
    expect(normalizeStoryCtaUrl(value)).toBe(expected);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "//evil.example/path",
    "/\\evil.example/path",
    "example.com/no-scheme",
    "https://user:secret@example.com",
  ])("rejects unsafe destination %s", (value) => {
    expect(() => normalizeStoryCtaUrl(value)).toThrow();
  });

  it("stores Persian paths percent-encoded and leaves encoded input unchanged", () => {
    const encoded = "/pdp/%DA%A9%D9%84%D8%A7%D9%87-%D8%A8%D8%A7%DA%A9%D8%AA";

    expect(normalizeStoryCtaUrl("/pdp/کلاه-باکت")).toBe(encoded);
    expect(normalizeStoryCtaUrl(encoded)).toBe(encoded);
  });

  it("accepts encoded links longer than 255 characters", () => {
    const value = `https://infinitycolor.co/pdp/${"%DA%A9".repeat(60)}`;

    expect(value.length).toBeGreaterThan(255);
    expect(normalizeStoryCtaUrl(value)).toBe(value);
  });

  it("rejects links that exceed the column only after encoding", () => {
    const value = `/pdp/${"ک".repeat(400)}`;

    expect(value.length).toBeLessThanOrEqual(STORY_CTA_URL_MAX_LENGTH);
    expect(() => normalizeStoryCtaUrl(value)).toThrow(StoryCtaValidationError);
  });

  it("rejects raw input longer than the column", () => {
    expect(() => normalizeStoryCtaUrl(`/pdp/${"a".repeat(STORY_CTA_URL_MAX_LENGTH)}`)).toThrow(
      StoryCtaValidationError,
    );
  });

  it("sets the fixed button label when a destination is present", () => {
    const data = { CtaUrl: "/pdp/example", CtaLabel: "متن دلخواه" };

    applyStoryCtaMutation(data);

    expect(data).toEqual({ CtaUrl: "/pdp/example", CtaLabel: STORY_CTA_LABEL });
  });

  it("clears both fields when the destination is removed", () => {
    const data: { CtaUrl: string | null; CtaLabel: string | null } = {
      CtaUrl: "",
      CtaLabel: STORY_CTA_LABEL,
    };

    applyStoryCtaMutation(data);

    expect(data).toEqual({ CtaUrl: null, CtaLabel: null });
  });

  it("does not allow the fixed label to be changed independently", () => {
    const data: { CtaLabel?: string } = { CtaLabel: "متن دلخواه" };

    applyStoryCtaMutation(data);

    expect(data).toEqual({});
  });
});
