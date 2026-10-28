import routeConfig from "../routes/custom-router";
describe("order operational route authorization", () => {
  it.each([
    ["/orders/:id/anipo-barcode", "order.shipping.manage"],
    ["/orders/:id/anipo-barcode/check", "order.shipping.manage"],
    ["/orders/:id/admin/adjust-items", "order.items.adjust"],
    ["/orders/:id/admin/notes", "order.notes.update"],
    ["/orders/:id/admin/address", "order.address.update"],
    ["/orders/:id/admin/transition", "order.status.update"],
    ["/orders/:id/admin/cancel", "order.cancel"],
    ["/orders/:id/admin/void-barcode", "order.shipping.manage"],
    ["/orders/:id/decrement-stock-manual", "order.manual.create"],
  ])("protects %s with %s", (path, capability) => {
    const route = routeConfig.routes.find((entry) => entry.path === path);
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability },
      },
    ]);
  });

  it("gates payment-operation status on order read; the handler scopes by operation type", () => {
    const route = routeConfig.routes.find(
      (entry) => entry.path === "/orders/:id/admin/payment-operations/:operationId",
    );
    expect(route?.config.policies).toEqual([
      {
        name: "global::require-capability",
        config: { capability: "order.read" },
      },
    ]);
  });
});
