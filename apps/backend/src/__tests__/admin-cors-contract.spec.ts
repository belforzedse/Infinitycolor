function loadCorsOrigin(environment: {
  frontend: string;
  admin: string;
}) {
  process.env.FRONTEND_URL = environment.frontend;
  process.env.ADMIN_URL = environment.admin;
  let middleware: any[] = [];
  jest.isolateModules(() => {
    middleware = require("../../config/middlewares").default;
  });
  return middleware.find((entry) => entry?.name === "strapi::cors").config.origin;
}

describe("admin exact-origin CORS contract", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  it("accepts staging admin without accepting the production admin", () => {
    const origin = loadCorsOrigin({
      frontend: "https://staging.infinitycolor.co",
      admin: "https://admin.staging.infinitycolor.co",
    });
    expect(origin({ request: { header: { origin: "https://admin.staging.infinitycolor.co" } } })).toBe(
      "https://admin.staging.infinitycolor.co",
    );
    expect(origin({ request: { header: { origin: "https://admin.infinitycolor.co" } } })).toBe("");
  });

  it("accepts production admin without accepting the staging admin", () => {
    const origin = loadCorsOrigin({
      frontend: "https://new.infinitycolor.co",
      admin: "https://admin.infinitycolor.co",
    });
    expect(origin({ request: { header: { origin: "https://admin.infinitycolor.co" } } })).toBe(
      "https://admin.infinitycolor.co",
    );
    expect(origin({ request: { header: { origin: "https://admin.staging.infinitycolor.co" } } })).toBe("");
  });
});
