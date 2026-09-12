import toast from "react-hot-toast";

/**
 * Runs one operation across a selection and reports what actually happened.
 *
 * Bulk handlers used to split into two bad shapes: a sequential `for` loop that
 * swallowed each failure into a bare `console.error` (so "موجودی ۱۲ تنوع حذف شد"
 * could be printed when nothing had been written), or a `Promise.all` where one
 * rejection discarded the outcome of every item that had already succeeded.
 *
 * Every message is injectable rather than templated here, so each caller keeps
 * the exact Persian wording its screen already used.
 */

export type BulkRunMessages = {
  progress?: (total: number) => string;
  success: (succeeded: number) => string;
  /** Distinct failure reasons are passed in, already user-facing. */
  failure: (failed: number, reasons: string[]) => string;
  skipped?: (skipped: number, reasons: string[]) => string;
  /** Used instead of `skipped` when nothing was eligible at all. */
  allSkipped?: (skipped: number, reasons: string[]) => string;
};

export type BulkRunOptions<T> = {
  execute: (item: T) => Promise<unknown>;
  /** Return a Persian reason to leave the item alone, or null to run it. */
  skip?: (item: T) => string | null;
  /** Turns a rejection into the user-facing reason shown in the failure toast. */
  describeError?: (error: unknown) => string;
  messages: BulkRunMessages;
  showProgressToast?: boolean;
};

export type BulkRunResult<T> = {
  succeeded: T[];
  failed: { item: T; error: unknown }[];
  skipped: { item: T; reason: string }[];
};

const distinct = (values: string[]) => [...new Set(values)];

export async function runBulkAction<T>(
  items: T[],
  options: BulkRunOptions<T>,
): Promise<BulkRunResult<T>> {
  const {
    execute,
    skip,
    describeError = (error) =>
      (error as { message?: string })?.message || "خطای نامشخص",
    messages,
    showProgressToast = true,
  } = options;

  const skipped: { item: T; reason: string }[] = [];
  const eligible: T[] = [];
  for (const item of items) {
    const reason = skip?.(item) ?? null;
    if (reason) skipped.push({ item, reason });
    else eligible.push(item);
  }

  if (eligible.length === 0) {
    const reasons = distinct(skipped.map((entry) => entry.reason));
    const message =
      messages.allSkipped?.(skipped.length, reasons) ??
      messages.skipped?.(skipped.length, reasons);
    if (message) toast.error(message);
    return { succeeded: [], failed: [], skipped };
  }

  const progressToast =
    showProgressToast && messages.progress
      ? toast.loading(messages.progress(eligible.length))
      : null;

  // allSettled, not all: partial success is the common case on a big selection
  // and it is exactly what the operator needs to know about.
  const results = await Promise.allSettled(eligible.map((item) => execute(item)));
  if (progressToast) toast.dismiss(progressToast);

  const succeeded: T[] = [];
  const failed: { item: T; error: unknown }[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") succeeded.push(eligible[index]);
    else failed.push({ item: eligible[index], error: result.reason });
  });

  if (succeeded.length > 0) toast.success(messages.success(succeeded.length));

  if (skipped.length > 0 && messages.skipped) {
    toast(messages.skipped(skipped.length, distinct(skipped.map((e) => e.reason))), {
      icon: "⏳",
    });
  }

  if (failed.length > 0) {
    failed.forEach((entry) =>
      console.error("Bulk action item failed:", entry.error),
    );
    toast.error(
      messages.failure(
        failed.length,
        distinct(failed.map((entry) => describeError(entry.error))),
      ),
    );
  }

  return { succeeded, failed, skipped };
}
