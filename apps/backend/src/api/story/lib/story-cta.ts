export const STORY_CTA_LABEL = "مشاهده لینک";

export class StoryCtaValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoryCtaValidationError";
  }
}

/**
 * Accept storefront-relative destinations and absolute HTTP(S) URLs only.
 * Returning a normalized value keeps unsafe schemes and protocol-relative URLs
 * out of both the persisted story and the public viewer response.
 */
export function normalizeStoryCtaUrl(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
  }

  const candidate = value.trim();
  if (!candidate) return null;
  if (candidate.length > 500 || /[\u0000-\u001F\u007F\\]/.test(candidate)) {
    throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
  }

  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//")) {
      throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
    }

    const parsed = new URL(candidate, "https://storefront.invalid");
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new StoryCtaValidationError("لینک استوری باید با / یا http شروع شود.");
  }

  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
  }

  return parsed.toString();
}

type StoryCtaMutation = {
  CtaLabel?: unknown;
  CtaUrl?: unknown;
};

/** Enforces the product-owned CTA copy whenever a destination is changed. */
export function applyStoryCtaMutation(data: StoryCtaMutation): void {
  if (!Object.prototype.hasOwnProperty.call(data, "CtaUrl")) {
    // The button label is fixed product copy, not an independently editable field.
    if (Object.prototype.hasOwnProperty.call(data, "CtaLabel")) delete data.CtaLabel;
    return;
  }

  const destination = normalizeStoryCtaUrl(data.CtaUrl);
  data.CtaUrl = destination;
  data.CtaLabel = destination ? STORY_CTA_LABEL : null;
}
