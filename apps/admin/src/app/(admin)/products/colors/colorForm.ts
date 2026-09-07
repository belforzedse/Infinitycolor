/**
 * Pure state rules for the dedicated colour form.
 *
 * These lived inline in the page and produced a dead end: the title field flipped
 * "بدون رنگ" on and blanked the colour code, and turning the option back off kept
 * the blank value, so the form could never pass validation again.
 */

/** Colour the picker falls back to whenever a real one is not selected yet. */
export const DEFAULT_COLOR_CODE = "#000000";

const HEX_SIX = /^#[0-9a-fA-F]{6}$/;

export type ColorFormState = {
  title: string;
  colorCode: string;
  noColor: boolean;
};

/**
 * Turning "بدون رنگ" off must hand back a usable colour rather than the blanked
 * value, otherwise the picker opens empty and saving always fails.
 */
export function applyNoColorToggle<T extends ColorFormState>(prev: T, checked: boolean): T {
  return {
    ...prev,
    noColor: checked,
    colorCode: checked ? "" : prev.colorCode || DEFAULT_COLOR_CODE,
  };
}

export type ColorSaveResolution =
  | { ok: true; title: string; colorCode: string | null }
  | { ok: false; message: string };

/**
 * Validates the form and produces the exact payload to persist. Colourless
 * entries persist `null`; everything else must be a normalised 6-digit hex.
 */
export function resolveColorSave(state: ColorFormState): ColorSaveResolution {
  const title = state.title.trim();
  if (!title) {
    return { ok: false, message: "نام رنگ را وارد کنید." };
  }

  if (state.noColor) {
    return { ok: true, title, colorCode: null };
  }

  const raw = (state.colorCode || "").trim();
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;

  if (!HEX_SIX.test(withHash)) {
    return {
      ok: false,
      // Say which of the two problems it actually is, and what to do next.
      message: raw
        ? "کد رنگ باید ۶ رقمی و مانند ‎#1E40AF باشد."
        : "یک رنگ از پالت انتخاب کنید یا گزینه «بدون رنگ» را بزنید.",
    };
  }

  return { ok: true, title, colorCode: withHash.toLowerCase() };
}
