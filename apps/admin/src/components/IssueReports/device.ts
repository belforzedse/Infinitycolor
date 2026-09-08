import UAParser from "ua-parser-js";

export function describeDevice(
  userAgent: string | null | undefined,
  androidHints?: { model: string | null; platformVersion: string | null },
) {
  // Never let the parser substitute the administrator's navigator.userAgent.
  if (!userAgent?.trim())
    return { device: "نامشخص", os: "نامشخص", browser: "نامشخص" };
  const result = new UAParser(userAgent).getResult();
  let device = [result.device.vendor, result.device.model]
    .filter(Boolean)
    .join(" ");
  let os =
    [result.os.name, result.os.version].filter(Boolean).join(" ") || "نامشخص";
  let osNote: string | undefined;
  let deviceNote: string | undefined;
  const safari =
    result.browser.name === "Mobile Safari" || result.browser.name === "Safari";
  const safariMajor = Number(result.browser.major);
  // Safari 26 freezes the iOS token at 18.6/18.7. Safari's major is an
  // estimate of the OS generation, not a measured OS or patch version.
  // https://webkit.org/blog/17333/webkit-features-in-safari-26-0/#update-to-ua-string
  if (result.os.name === "iOS" && safari && safariMajor >= 26) {
    os = `${result.device.model === "iPad" ? "iPadOS" : "iOS"} ${safariMajor}`;
    osNote = "برآورد از نسخهٔ سافاری؛ نسخهٔ دقیق در دسترس نیست";
  } else if (
    result.os.name === "iOS" &&
    /^18\.(6|7)(\.|$)/.test(result.os.version || "")
  ) {
    os = "iOS";
    osNote = "نسخهٔ دقیق در دسترس نیست";
  }
  if (result.os.name === "Mac OS") {
    os = "macOS";
    osNote = "نسخهٔ دقیق در دسترس نیست";
  }
  if (result.os.name === "Windows" && result.os.version === "10") {
    os = "Windows 10 / 11";
  }
  if (result.os.name === "Android") {
    const hintedModel = androidHints?.model?.trim();
    const model = hintedModel && hintedModel !== "K" ? hintedModel : null;
    if (model) device = model;
    const version = androidHints?.platformVersion;
    if (version && /^\d{1,3}(?:\.\d{1,4}){0,3}$/.test(version))
      os = `Android ${version}`;
    else if (/Android 10; K[;)]/.test(userAgent)) {
      os = "Android";
      osNote = "نسخهٔ دقیق در دسترس نیست";
    }
    if (result.device.model === "K" && !model) device = "";
  }
  if (["iPhone", "iPad", "iPod"].includes(result.device.model || "")) {
    deviceNote = "مدل دقیق در دسترس نیست";
  }
  const types: Record<string, string> = {
    mobile: "موبایل",
    tablet: "تبلت",
    smarttv: "تلویزیون",
    wearable: "پوشیدنی",
    console: "کنسول",
  };
  return {
    device:
      device ||
      types[result.device.type || ""] ||
      (["Windows", "Mac OS", "Linux", "Ubuntu", "Chrome OS"].includes(
        result.os.name || "",
      )
        ? "رایانه"
        : "نامشخص"),
    os,
    ...(osNote ? { osNote } : {}),
    ...(deviceNote ? { deviceNote } : {}),
    browser:
      [result.browser.name, result.browser.version].filter(Boolean).join(" ") ||
      "نامشخص",
  };
}
