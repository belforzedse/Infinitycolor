const frontendUrl = process.env.FRONTEND_URL || process.env.FRONTEND_BASE_URL || "https://infinitycolor.co";
const adminUrl =
  process.env.ADMIN_URL ||
  (frontendUrl.includes("staging.infinitycolor.co")
    ? "https://admin.staging.infinitycolor.co"
    : process.env.NODE_ENV === "production"
      ? "https://admin.infinitycolor.co"
      : "http://localhost:2891");

function exactOrigin(name: string, value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${name} must be an exact HTTP(S) origin`);
  }
  return url.origin;
}

const exactFrontendOrigin = exactOrigin("FRONTEND_URL", frontendUrl);
const exactAdminOrigin = exactOrigin("ADMIN_URL", adminUrl);
const corsOrigins = (
  exactAdminOrigin === "https://admin.staging.infinitycolor.co"
    ? [exactFrontendOrigin, exactAdminOrigin, "https://staging.infinitycolor.co"]
    : exactAdminOrigin === "https://admin.infinitycolor.co"
      ? [
          exactFrontendOrigin,
          exactAdminOrigin,
          "https://new.infinitycolor.co",
          "https://infinitycolor.co",
          "https://infinitygram.co",
        ]
      : [
          exactFrontendOrigin,
          exactAdminOrigin,
          "http://localhost:2888",
          "http://127.0.0.1:2888",
          "http://localhost:2891",
          "http://127.0.0.1:2891",
          "http://localhost:2890",
          "http://127.0.0.1:2890",
        ]
).filter((origin, i, arr) => arr.indexOf(origin) === i);

const allowedOriginsSet = new Set(corsOrigins);

/** Max multipart upload size (bytes). Override with STRAPI_MAX_UPLOAD_SIZE_MB (default 256). */
const maxUploadBytes =
  (Number.parseInt(process.env.STRAPI_MAX_UPLOAD_SIZE_MB ?? "256", 10) || 256) * 1024 * 1024;
const maxUploadLabel = `${Math.round(maxUploadBytes / 1024 / 1024)}mb`;

export default [
  "strapi::logger",
  "strapi::errors",
  // Merge duplicate slashes before static-serving/routing so malformed paths like
  // `//rest-cache/config/strategy` (from third-party admin plugins) route instead of 400-ing.
  "global::normalize-path",
  "strapi::security",
  {
    name: "strapi::cors",
    config: {
      origin: (ctx: { request: { header: { origin?: string } } }): string | string[] => {
        const origin = ctx.request.header.origin;
        if (origin && allowedOriginsSet.has(origin)) {
          return origin;
        }
        return "";
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      headers: [
        "Content-Type",
        "Authorization",
        "Origin",
        "Accept",
        "Accept-Language",
        "x-skip-global-loader",
        "X-Correlation-Id",
        "X-Interaction-Id",
      ],
      expose: ["X-Request-Id"],
      keepHeaderOnError: true,
    },
  },
  "strapi::query",
  {
    name: "strapi::body",
    config: {
      // Reduced from 500MB to reasonable limits for security and memory safety
      // 500MB limits were a DoS vector and could cause memory pressure
      jsonLimit: "10mb",      // JSON API requests (was 500mb)
      formLimit: maxUploadLabel, // multipart forms — must fit max video upload
      textLimit: "10mb",      // Text payloads (was 500mb)
      multipart: true,
      formidable: {
        maxFileSize: maxUploadBytes,
      },
    },
  },
  "strapi::session",
  "strapi::favicon",
  "strapi::public",
  "global::audit-context",
  "global::cache-headers",
];
