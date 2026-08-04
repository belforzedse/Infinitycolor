describe("admin PWA identities", () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
    jest.resetModules();
  });

  it.each([
    ["production", "/infinity-admin", "/icons/admin-maskable-512.png"],
    ["staging", "/infinity-admin-staging", "/icons/admin-staging-maskable-512.png"],
  ])("uses an independent %s install identity", (environment, id, maskable) => {
    process.env.NODE_ENV = "production";
    process.env.NEXT_PUBLIC_ADMIN_ENVIRONMENT = environment;
    const manifest = require("./manifest").default();
    expect(manifest).toMatchObject({ id, scope: "/", start_url: "/", display: "standalone" });
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ src: maskable, purpose: "maskable" }),
    );
  });
});
