import http from "k6/http";
import { check, sleep } from "k6";

const storefront = (__ENV.STOREFRONT_URL || "http://localhost:2888").replace(/\/$/, "");
const admin = (__ENV.ADMIN_URL || "http://localhost:2891").replace(/\/$/, "");
const api = (__ENV.API_URL || "http://127.0.0.1:1337/api").replace(/\/$/, "");
const auth = (__ENV.AUTH_URL || "http://localhost:2889").replace(/\/$/, "");
const authCookie = __ENV.ADMIN_AUTH_COOKIE || "";
let bearer = "";
let bearerIssuedAt = 0;

const scenarios = {};
let startSeconds = 0;
for (const vus of [1, 5, 10, 25]) {
  scenarios[`c${vus}_warmup`] = {
    executor: "constant-vus",
    vus,
    duration: "30s",
    startTime: `${startSeconds}s`,
    tags: { concurrency: String(vus), phase: "warmup" },
  };
  startSeconds += 30;
  for (let repetition = 1; repetition <= 3; repetition += 1) {
    scenarios[`c${vus}_r${repetition}`] = {
      executor: "constant-vus",
      vus,
      duration: "2m",
      startTime: `${startSeconds}s`,
      tags: { concurrency: String(vus), phase: "measured", repetition: String(repetition) },
    };
    startSeconds += 120;
  }
}

export const options = { scenarios, discardResponseBodies: true };

function currentBearer() {
  if (!authCookie) return "";
  if (bearer && Date.now() - bearerIssuedAt < 45_000) return bearer;
  const response = http.get(`${auth}/api/auth/token`, {
    headers: { Cookie: authCookie, Origin: admin, Accept: "application/json" },
    tags: { surface: "shared-auth", flow: "short-bearer" },
    responseType: "text",
  });
  if (response.status !== 200) return "";
  try {
    bearer = JSON.parse(response.body).token || "";
    bearerIssuedAt = Date.now();
  } catch {
    bearer = "";
  }
  return bearer;
}

export default function () {
  const shortBearer = currentBearer();
  const params = { headers: shortBearer ? { Authorization: `Bearer ${shortBearer}` } : {} };
  const responses = http.batch([
    ["GET", `${storefront}/`, null, { tags: { surface: "storefront", flow: "home" } }],
    ["GET", `${admin}/api/health/live`, null, { tags: { surface: "admin", flow: "liveness" } }],
    ["GET", `${admin}/manifest.webmanifest`, null, { tags: { surface: "admin", flow: "static" } }],
    ["GET", `${api}/auth/self`, null, { ...params, tags: { surface: "shared-api", flow: "current-user" } }],
    ["GET", `${api}/products?pagination[pageSize]=25`, null, { ...params, tags: { surface: "admin", flow: "catalog-read" } }],
    ["GET", `${api}/orders?pagination[pageSize]=25`, null, { ...params, tags: { surface: "admin", flow: "order-read" } }],
    ["GET", `${api}/reports/product-sales`, null, { ...params, tags: { surface: "admin", flow: "report" } }],
  ]);
  check(responses[0], { "storefront responds": (response) => response.status < 500 });
  check(responses[1], { "admin identity is live": (response) => response.status === 200 });
  check(responses[3], { "admin bearer remains valid": (response) => !authCookie || response.status === 200 });
  sleep(1);
}
