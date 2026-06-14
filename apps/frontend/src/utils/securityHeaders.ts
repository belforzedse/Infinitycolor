import {
  getTrustedApiSourceOrigins,
  getTrustedImageSourceOrigins,
} from "./imageSecurity";

type SecurityHeader = {
  key: string;
  value: string;
};

const DEFAULT_MATOMO_URL = "https://analytics.infinitycolor.co";

function unique(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function originFromUrl(raw?: string | null): string | null {
  const value = raw?.trim();
  if (!value) return null;

  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function originFromSentryDsn(raw?: string | null): string | null {
  return originFromUrl(raw);
}

function getMatomoOrigin(): string {
  return originFromUrl(process.env.NEXT_PUBLIC_MATOMO_URL) || DEFAULT_MATOMO_URL;
}

function getSentryOrigin(): string | null {
  return originFromSentryDsn(process.env.NEXT_PUBLIC_SENTRY_DSN);
}

export function getContentSecurityPolicyReportOnly(): string {
  const imageSources = unique([
    "'self'",
    "data:",
    "blob:",
    ...getTrustedImageSourceOrigins(),
    getMatomoOrigin(),
  ]);
  const connectSources = unique([
    "'self'",
    ...getTrustedApiSourceOrigins(),
    getMatomoOrigin(),
    getSentryOrigin(),
  ]);

  // Non-self sources are intentionally limited to Strapi/API media, Matomo,
  // Sentry transport, and the configured payment gateway form/redirect hosts.
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    [
      "form-action",
      "'self'",
      "https://www.zarinpal.com",
      "https://sandbox.zarinpal.com",
      "https://bpm.shaparak.ir",
    ].join(" "),
    ["script-src", "'self'", "'unsafe-inline'", "'unsafe-eval'", getMatomoOrigin()].join(" "),
    "style-src 'self' 'unsafe-inline'",
    ["img-src", ...imageSources].join(" "),
    "font-src 'self' data:",
    ["connect-src", ...connectSources].join(" "),
    ["media-src", ...imageSources].join(" "),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self'",
  ].join("; ");
}

export function getSecurityHeaderEntries(): ReadonlyArray<readonly [string, string]> {
  return [
    ["X-Content-Type-Options", "nosniff"],
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "strict-origin-when-cross-origin"],
    [
      "Permissions-Policy",
      [
        "camera=()",
        "microphone=()",
        "geolocation=()",
        "usb=()",
        "magnetometer=()",
        "gyroscope=()",
        "accelerometer=()",
        "payment=()",
        "interest-cohort=()",
      ].join(", "),
    ],
    ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
    ["Content-Security-Policy-Report-Only", getContentSecurityPolicyReportOnly()],
  ];
}

export function getSecurityHeaders(): SecurityHeader[] {
  return getSecurityHeaderEntries().map(([key, value]) => ({ key, value }));
}
