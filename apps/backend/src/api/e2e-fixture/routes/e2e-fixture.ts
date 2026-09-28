// Staging-only test data for apps/e2e/tests/staging. Every route answers 404
// unless the environment opted in (see src/utils/e2eFixtures.ts).
const config = {
  auth: false as const,
  policies: [],
  middlewares: ["api::e2e-fixture.require-fixture-token"],
};

export default {
  routes: [
    { method: "POST", path: "/e2e-fixtures/shoppers", handler: "e2e-fixture.provision", config },
    { method: "GET", path: "/e2e-fixtures/shoppers/:slot/stock", handler: "e2e-fixture.stock", config },
    { method: "POST", path: "/e2e-fixtures/shoppers/:slot/cleanup", handler: "e2e-fixture.cleanup", config },
    { method: "POST", path: "/e2e-fixtures/shoppers/:slot/product", handler: "e2e-fixture.product", config },
  ],
};
