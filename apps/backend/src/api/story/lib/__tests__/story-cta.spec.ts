import { applyStoryCtaMutation, normalizeStoryCtaUrl, STORY_CTA_LABEL } from "../story-cta";

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
