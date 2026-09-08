import type { IssueReportClientContext } from "@/services/issue-reports";

// Only requested when the customer submits a report; never used for analytics
// or adaptive quality. Unsupported/denied hints must not prevent submission.
export async function collectAndroidHints(): Promise<Pick<IssueReportClientContext, "androidHints">> {
  const data = (navigator as Navigator & {
    userAgentData?: {
      platform?: string;
      getHighEntropyValues?: (hints: string[]) => Promise<{ model?: unknown; platformVersion?: unknown }>;
    };
  }).userAgentData;
  if (data?.platform !== "Android" || !data.getHighEntropyValues) return {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const hints = await Promise.race([
      data.getHighEntropyValues(["model", "platformVersion"]),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 300); }),
    ]);
    const model = typeof hints?.model === "string" ? hints.model.trim().slice(0, 120) || null : null;
    const platformVersion = typeof hints?.platformVersion === "string" && /^\d{1,3}(?:\.\d{1,4}){0,3}$/.test(hints.platformVersion) ? hints.platformVersion : null;
    return model || platformVersion ? { androidHints: { model, platformVersion } } : {};
  } catch { return {}; }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
