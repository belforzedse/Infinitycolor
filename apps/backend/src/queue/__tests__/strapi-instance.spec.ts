const app = {
  load: jest.fn().mockResolvedValue(undefined),
  start: jest.fn().mockResolvedValue(undefined),
  destroy: jest.fn().mockResolvedValue(undefined),
};

const createStrapi = jest.fn(() => app) as jest.Mock & {
  compile: jest.Mock;
};
createStrapi.compile = jest.fn().mockResolvedValue({ distDir: "./dist" });

jest.mock("@strapi/strapi", () => createStrapi);

import { createLoadedStrapi } from "../strapi-instance";

describe("worker Strapi instance", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("loads Strapi services in production without starting HTTP", async () => {
    process.env.NODE_ENV = "production";

    const loaded = await createLoadedStrapi();

    expect(loaded).toBe(app);
    expect(createStrapi).toHaveBeenCalledWith({ distDir: "./dist" });
    expect(app.load).toHaveBeenCalledTimes(1);
    expect(app.start).not.toHaveBeenCalled();
  });

  it("uses Strapi compile context outside production", async () => {
    process.env.NODE_ENV = "development";

    await createLoadedStrapi();

    expect(createStrapi.compile).toHaveBeenCalledTimes(1);
    expect(createStrapi).toHaveBeenCalledWith({ distDir: "./dist" });
    expect(app.load).toHaveBeenCalledTimes(1);
  });

  it("destroys a partially loaded instance while preserving the startup failure", async () => {
    const error = new Error("database unavailable");
    app.load.mockRejectedValueOnce(error);
    app.destroy.mockRejectedValueOnce(new Error("cleanup failed"));

    await expect(createLoadedStrapi()).rejects.toBe(error);
    expect(app.destroy).toHaveBeenCalledTimes(1);
  });
});
