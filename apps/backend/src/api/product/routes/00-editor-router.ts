const capability = (name: string) => ({ name: "global::require-capability", config: { capability: name } });
const route = (method: string, path: string, handler: string, cap: string, guarded = false) => ({
  method, path, handler: `product.${handler}`,
  config: { auth: { scope: [] }, policies: [capability(cap)], middlewares: guarded ? [{ name: "global::catalog-edit", config: { resource: "product" } }] : [] },
});
export default { routes: [
  route("GET", "/products/:id/edit-lease", "editLease", "product.read"),
  route("GET", "/products/:id/edit-snapshot", "editSnapshot", "product.read"),
  route("POST", "/products/:id/edit-lease/acquire", "editAcquire", "product.read"),
  route("POST", "/products/:id/edit-lease/renew", "editRenew", "product.read"),
  route("POST", "/products/:id/edit-lease/takeover", "editTakeover", "product.read"),
  route("POST", "/products/:id/edit-lease/release", "editRelease", "product.read"),
  route("PUT", "/products/:id/editor", "editor", "product.update", true),
  route("PUT", "/products/:id/editor/variations/:variationId", "editorVariation", "product.variation.manage", true),
  route("PUT", "/products/:id/editor/homepage", "editorHomepage", "product.homepage.manage", true),
  route("POST", "/products/editor/bulk-stock", "editorBulkStock", "product.stock.update"),
] };
