const baseUrl = (process.argv[2] || process.env.SECURITY_HEADER_BASE_URL || "https://new.infinitycolor.co").replace(/\/$/, "");
const payload = "</script><img src=x onerror=alert(1)>";

const requiredHeaders = new Map([
  ["x-content-type-options", "nosniff"],
  ["x-frame-options", "SAMEORIGIN"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
  ["permissions-policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()"],
  ["strict-transport-security", "max-age=31536000"],
]);

const checks = [
  { label: "homepage", path: "/" },
  { label: "legacy redirect", path: "/shop/pants/page/2/", redirect: "manual" },
  { label: "private route", path: "/account" },
  { label: "reflected payload", path: `/?utm_campaign=${encodeURIComponent(payload)}`, inspectBody: true },
];

let failed = false;

function headerValue(headers, name) {
  return headers.get(name) || "";
}

function reportFailure(label, message) {
  failed = true;
  console.error(`[security-headers] ${label}: ${message}`);
}

for (const check of checks) {
  const url = `${baseUrl}${check.path}`;
  const response = await fetch(url, {
    redirect: check.redirect || "follow",
  });

  console.log(`[security-headers] ${check.label}: ${response.status} ${url}`);

  for (const [key, expected] of requiredHeaders) {
    const actual = headerValue(response.headers, key);
    if (actual !== expected) {
      reportFailure(check.label, `${key} expected "${expected}", got "${actual || "<missing>"}"`);
    }
  }

  if (!headerValue(response.headers, "content-security-policy-report-only")) {
    reportFailure(check.label, "content-security-policy-report-only is missing");
  }

  if (headerValue(response.headers, "x-powered-by")) {
    reportFailure(check.label, `x-powered-by should be absent, got "${headerValue(response.headers, "x-powered-by")}"`);
  }

  if (check.inspectBody) {
    const body = await response.text();
    if (body.includes(payload) || body.includes("<img src=x onerror=alert(1)>")) {
      reportFailure(check.label, "payload is present as raw HTML");
    }
    if (!body.includes("\\u003c/script\\u003e")) {
      console.warn("[security-headers] reflected payload: escaped script marker was not found; verify this route still reflects the probe before treating it as a regression.");
    }
  }
}

if (failed) {
  process.exitCode = 1;
}
