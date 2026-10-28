import type { Strapi } from "@strapi/strapi";
import type { Context } from "koa";
import createController from "../controllers/product-title-suggestions";
import { readProductKeywords } from "../services/product-title-keywords";
import suggestionsRouter from "../routes/00-title-suggestions";

jest.mock("../services/product-title-keywords", () => ({
  readProductKeywords: jest.fn(),
}));

const mockedRead = jest.mocked(readProductKeywords);

describe("product-title-suggestions controller", () => {
  beforeEach(() => {
    mockedRead.mockReset();
  });

  it("returns keywords and prevents response caching", async () => {
    mockedRead.mockResolvedValue(["شومیز", "نخی"]);

    const strapi = {} as Strapi;
    const controller = createController({ strapi });

    const setHeader = jest.fn();
    const ctx = {
      set: setHeader,
    } as unknown as Context;

    await controller.index(ctx);

    expect(mockedRead).toHaveBeenCalledWith(strapi);

    expect(ctx.body).toEqual({
      data: {
        keywords: ["شومیز", "نخی"],
      },
    });

    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
  });

  it("propagates a database failure without returning empty keywords", async () => {
    const error = new Error("Database unavailable");
    mockedRead.mockRejectedValue(error);

    const strapi = {} as Strapi;
    const controller = createController({ strapi });
    const ctx = {} as Context;

    await expect(controller.index(ctx)).rejects.toThrow(error);
    expect(ctx.body).toBeUndefined();
  });
});
describe("product title suggestions route", () => {
  it("requires authentication and the product.read capability", () => {
    const route = suggestionsRouter.routes.find(
      (item) => item.method === "GET" && item.path === "/products/title-keywords",
    );

    expect(route).toBeDefined();

    expect(route?.handler).toBe("product-title-suggestions.index");

    expect(route?.config.auth).toEqual({
      scope: [],
    });

    expect(route?.config.policies).toContainEqual({
      name: "global::require-capability",
      config: {
        capability: "product.read",
      },
    });
  });
});
