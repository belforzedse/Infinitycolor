import { applyNoColorToggle, DEFAULT_COLOR_CODE, resolveColorSave } from "../colorForm";

/**
 * The owner reported being unable to add a colour on the dedicated page. The API
 * accepts creates for every admin role except Editor, so the block was in this
 * form: "بدون رنگ" blanked the colour code, and turning it back off kept the
 * blank, leaving the picker empty and the form permanently unsaveable.
 */
describe("applyNoColorToggle", () => {
  it("clears the colour when the operator chooses بدون رنگ", () => {
    const next = applyNoColorToggle(
      { title: "سرمه‌ای", colorCode: "#1e40af", noColor: false },
      true,
    );

    expect(next).toMatchObject({ noColor: true, colorCode: "" });
  });

  it("hands back a usable colour when the option is turned off again", () => {
    const cleared = applyNoColorToggle({ title: "سرمه‌ای", colorCode: "#1e40af", noColor: false }, true);
    const restored = applyNoColorToggle(cleared, false);

    expect(restored.noColor).toBe(false);
    expect(restored.colorCode).toBe(DEFAULT_COLOR_CODE);
    // The regression: this used to stay "" and could never be saved.
    expect(resolveColorSave(restored).ok).toBe(true);
  });

  it("keeps an already-chosen colour when toggling off", () => {
    const next = applyNoColorToggle({ title: "سرمه‌ای", colorCode: "#1e40af", noColor: false }, false);

    expect(next.colorCode).toBe("#1e40af");
  });
});

describe("resolveColorSave", () => {
  it("persists a normalised hex", () => {
    expect(resolveColorSave({ title: "  سرمه‌ای  ", colorCode: "#1E40AF", noColor: false })).toEqual({
      ok: true,
      title: "سرمه‌ای",
      colorCode: "#1e40af",
    });
  });

  it("accepts a hex typed without the leading hash", () => {
    expect(resolveColorSave({ title: "سرمه‌ای", colorCode: "1E40AF", noColor: false })).toEqual({
      ok: true,
      title: "سرمه‌ای",
      colorCode: "#1e40af",
    });
  });

  it("persists null for a deliberately colourless entry", () => {
    expect(resolveColorSave({ title: "کد ۱", colorCode: "", noColor: true })).toEqual({
      ok: true,
      title: "کد ۱",
      colorCode: null,
    });
  });

  it("does not let a name alone decide the colour", () => {
    // A title containing "کد" used to force بدون رنگ on and wipe the picked colour.
    expect(resolveColorSave({ title: "آبی کد ۳", colorCode: "#1e40af", noColor: false })).toEqual({
      ok: true,
      title: "آبی کد ۳",
      colorCode: "#1e40af",
    });
  });

  it("asks for a name when it is missing", () => {
    expect(resolveColorSave({ title: "   ", colorCode: "#1e40af", noColor: false })).toEqual({
      ok: false,
      message: "نام رنگ را وارد کنید.",
    });
  });

  it("tells the operator to pick a colour when none is set", () => {
    const result = resolveColorSave({ title: "سرمه‌ای", colorCode: "", noColor: false });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty(
      "message",
      "یک رنگ از پالت انتخاب کنید یا گزینه «بدون رنگ» را بزنید.",
    );
  });

  it("explains the expected format when the code is malformed", () => {
    const result = resolveColorSave({ title: "سرمه‌ای", colorCode: "#12", noColor: false });

    expect(result.ok).toBe(false);
    expect(result).toHaveProperty("message", "کد رنگ باید ۶ رقمی و مانند ‎#1E40AF باشد.");
  });
});
