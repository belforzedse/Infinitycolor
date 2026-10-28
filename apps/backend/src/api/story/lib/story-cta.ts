export const STORY_CTA_LABEL = "مشاهده لینک";

/** Matches the `cta_url` columns (`columnType` varchar(2048)) on stories and story items. */
export const STORY_CTA_URL_MAX_LENGTH = 2048;

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
  if (candidate.length > STORY_CTA_URL_MAX_LENGTH || /[\u0000-\u001F\u007F\\]/.test(candidate)) {
    throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
  }

  if (candidate.startsWith("/")) {
    if (candidate.startsWith("//")) {
      throw new StoryCtaValidationError("لینک استوری معتبر نیست.");
    }

    const parsed = new URL(candidate, "https://storefront.invalid");
    return assertStoredLength(`${parsed.pathname}${parsed.search}${parsed.hash}`);
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

  return assertStoredLength(parsed.toString());
}

// URL parsing percent-encodes non-ASCII paths (~6 chars per Persian letter), so the
// stored value can be several times longer than the input that passed the first check.
function assertStoredLength(normalized: string): string {
  if (normalized.length > STORY_CTA_URL_MAX_LENGTH) {
    throw new StoryCtaValidationError("لینک استوری بیش از حد طولانی است.");
  }
  return normalized;
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
