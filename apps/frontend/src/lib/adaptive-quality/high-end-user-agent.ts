export type HighEndUserAgentFamily =
  | "apple-iphone"
  | "google-pixel-pro"
  | "samsung-galaxy-s"
  | "samsung-galaxy-foldable"
  | "oneplus-flagship"
  | "xiaomi-ultra";

export type HighEndUserAgentAdmission = {
  eligible: boolean;
  family?: HighEndUserAgentFamily;
  source: "user-agent" | "user-agent-client-hint" | "none";
};

type UserAgentAdmissionInput = {
  userAgent?: unknown;
  model?: unknown;
  modelSource?: "user-agent" | "user-agent-client-hint";
};

type NavigatorWithUserAgentData = Navigator & {
  userAgentData?: {
    getHighEntropyValues?: (hints: string[]) => Promise<{ model?: unknown }>;
  };
};

const NO_ADMISSION: HighEndUserAgentAdmission = Object.freeze({
  eligible: false,
  source: "none",
});

const HIGH_END_ANDROID_RULES: ReadonlyArray<{
  family: Exclude<HighEndUserAgentFamily, "apple-iphone">;
  pattern: RegExp;
}> = [
  {
    family: "google-pixel-pro",
    pattern: /\bPixel (?:8|9|10) Pro(?: XL| Fold)?\b/i,
  },
  {
    family: "samsung-galaxy-s",
    pattern:
      /\b(?:SM-S(?:91[168]|92[168]|93[168]|948)[A-Z0-9]*|Galaxy S(?:23|24|25)(?:\+| Plus| Ultra)?|Galaxy S26 Ultra)\b/i,
  },
  {
    family: "samsung-galaxy-foldable",
    pattern: /\b(?:SM-F(?:731|741|766|946|956|966)[A-Z0-9]*|Galaxy Z (?:Flip|Fold)(?:5|6|7))\b/i,
  },
  {
    family: "oneplus-flagship",
    pattern: /\b(?:OnePlus(?: |-)(?:12|13)(?:R)?|CPH(?:2581|2583|2653))\b/i,
  },
  {
    family: "xiaomi-ultra",
    pattern: /\bXiaomi (?:14|15) Ultra\b/i,
  },
];

/**
 * This is an admission gate, not a capability score. A matching family still
 * has to pass the controller's live smoothness proof before it can promote.
 *
 * Safari deliberately exposes only the iPhone family in its UA, not the model.
 * We therefore admit an iPhone UA as a family candidate and rely on the live
 * observation windows to reject a device that cannot sustain richer rendering.
 */
export function classifyHighEndUserAgent(
  input: UserAgentAdmissionInput,
): HighEndUserAgentAdmission {
  const userAgent = normalizeReportedValue(input.userAgent);
  if (!userAgent) return NO_ADMISSION;

  if (/\biPhone\b/i.test(userAgent)) {
    return {
      eligible: true,
      family: "apple-iphone",
      source: "user-agent",
    };
  }

  if (!/\bAndroid\b/i.test(userAgent)) return NO_ADMISSION;

  const source = input.modelSource || "user-agent";
  const reportedModel = normalizeReportedValue(input.model);
  const candidates =
    source === "user-agent-client-hint" && reportedModel
      ? [reportedModel]
      : [reportedModel, userAgent].filter(Boolean);

  for (const candidate of candidates) {
    for (const rule of HIGH_END_ANDROID_RULES) {
      rule.pattern.lastIndex = 0;
      if (rule.pattern.test(candidate)) {
        return {
          eligible: true,
          family: rule.family,
          source,
        };
      }
    }
  }

  return NO_ADMISSION;
}

export async function resolveHighEndUserAgentAdmission(
  navigatorValue: Navigator = navigator,
): Promise<HighEndUserAgentAdmission> {
  const userAgent = navigatorValue.userAgent;
  const legacyDecision = classifyHighEndUserAgent({ userAgent });
  if (legacyDecision.eligible) return legacyDecision;

  const userAgentData = (navigatorValue as NavigatorWithUserAgentData).userAgentData;
  if (typeof userAgentData?.getHighEntropyValues !== "function") {
    return NO_ADMISSION;
  }

  try {
    const values = await userAgentData.getHighEntropyValues(["model"]);
    return classifyHighEndUserAgent({
      userAgent,
      model: values.model,
      modelSource: "user-agent-client-hint",
    });
  } catch {
    return NO_ADMISSION;
  }
}

function normalizeReportedValue(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 512);
}
