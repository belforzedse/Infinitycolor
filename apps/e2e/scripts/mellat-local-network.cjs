// The lab's HTTP clients may connect only to loopback (Docker uses its local Unix socket).
const local = (input) => {
  const host = typeof input === "string" || input instanceof URL
    ? new URL(input).hostname
    : input?.hostname || input?.host || "localhost";
  if (!/^(localhost|127\.0\.0\.1|\[?::1\]?)(:\d+)?$/.test(host)) {
    throw new Error("MELLAT_LAB_NONLOCAL_HTTP_REFUSED");
  }
};
for (const module of [require("node:http"), require("node:https")]) {
  for (const name of ["request", "get"]) {
    const original = module[name];
    module[name] = function (input, ...args) { local(input); return original.call(this, input, ...args); };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, ...args) => {
  try { local(input instanceof Request ? input.url : input); }
  catch (error) { return Promise.reject(error); }
  return originalFetch(input, ...args);
};
