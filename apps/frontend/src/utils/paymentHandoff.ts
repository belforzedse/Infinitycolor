export type PaymentHandoff = {
  redirectUrl?: string;
  redirectMethod?: "GET" | "POST";
  formFields?: Record<string, string>;
  refId?: string;
};

/** Count only time the checkout is visible; leaving the page completes the handoff. */
export function watchPaymentHandoff(onStalled: () => void, visibleMs = 10_000): () => void {
  let remaining = visibleMs;
  let visibleSince: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const pause = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (visibleSince !== undefined) remaining -= Math.max(0, Date.now() - visibleSince);
    visibleSince = undefined;
  };
  const stop = () => {
    stopped = true;
    pause();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", stop);
  };
  const resume = () => {
    if (stopped || document.visibilityState === "hidden") return;
    visibleSince = Date.now();
    timer = setTimeout(() => {
      if (document.visibilityState === "hidden") {
        pause();
        return;
      }
      stop();
      onStalled();
    }, Math.max(0, remaining));
  };
  const onVisibilityChange = () => {
    pause();
    resume();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", stop, { once: true });
  resume();
  return stop;
}

/**
 * Enters a payment provider using the server-declared transport contract.
 * SEP and Mellat require an HTML form POST; ZarinPal and SnappPay use a plain
 * navigation. Provider references are never appended to URLs here.
 */
export function submitPaymentHandoff(
  handoff: PaymentHandoff,
  navigate: (url: string) => void = (url) => window.location.assign(url),
): boolean {
  const url = String(handoff.redirectUrl || "").trim();
  if (!url) return false;

  if (handoff.redirectMethod === "POST") {
    const fields = handoff.formFields ??
      (handoff.refId ? { RefId: String(handoff.refId) } : {});
    if (Object.keys(fields).length === 0) return false;

    const form = document.createElement("form");
    form.method = "POST";
    form.action = url;
    form.style.display = "none";
    for (const [name, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      input.value = String(value);
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    return true;
  }

  navigate(url);
  return true;
}
