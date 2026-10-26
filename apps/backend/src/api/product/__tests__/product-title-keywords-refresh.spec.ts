import type { Strapi } from "@strapi/strapi";

import { rebuildProductKeywords } from "../services/product-title-keywords";

import {
  refreshProductKeywords,
  waitForProductKeywordsRefresh,
} from "../services/product-title-keywords-refresh";

jest.mock("../services/product-title-keywords", () => ({
  rebuildProductKeywords: jest.fn(),
}));

const mockedRebuild = jest.mocked(rebuildProductKeywords);

describe("refreshProductKeywords", () => {
  beforeEach(() => {
    mockedRebuild.mockReset();
    mockedRebuild.mockResolvedValue("keywords.json");
  });

  it("collects requests during a rebuild and runs again afterwards", async () => {
    let finishFirstRebuild!: (filePath: string) => void;

    mockedRebuild.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishFirstRebuild = resolve;
        }),
    );

    const strapi = {} as Strapi;

    const first = refreshProductKeywords(strapi);
    const second = refreshProductKeywords(strapi);
    const third = refreshProductKeywords(strapi);

    expect(mockedRebuild).toHaveBeenCalledTimes(1);

    finishFirstRebuild("keywords.json");

    await Promise.all([first, second, third]);

    expect(mockedRebuild).toHaveBeenCalledTimes(2);
    expect(mockedRebuild).toHaveBeenNthCalledWith(2, strapi);
  });

  it("allows another refresh after a failure", async () => {
    const strapi = {} as Strapi;
    const error = new Error("Database unavailable");

    mockedRebuild.mockRejectedValueOnce(error);

    await expect(refreshProductKeywords(strapi)).rejects.toThrow(error);

    await expect(refreshProductKeywords(strapi)).resolves.toBeUndefined();

    expect(mockedRebuild).toHaveBeenCalledTimes(2);
  });
  it("waits for an active refresh without starting another rebuild", async () => {
    const strapi = {} as Strapi;

    await waitForProductKeywordsRefresh(strapi);

    expect(mockedRebuild).not.toHaveBeenCalled();

    let finishRebuild!: (filePath: string) => void;

    mockedRebuild.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finishRebuild = resolve;
        }),
    );

    const refresh = refreshProductKeywords(strapi);
    const waiting = waitForProductKeywordsRefresh(strapi);

    let finishedWaiting = false;

    const observedWaiting = waiting.then(() => {
      finishedWaiting = true;
    });

    await Promise.resolve();

    expect(finishedWaiting).toBe(false);
    expect(mockedRebuild).toHaveBeenCalledTimes(1);

    finishRebuild("keywords.json");

    await Promise.all([refresh, observedWaiting]);

    expect(finishedWaiting).toBe(true);
    expect(mockedRebuild).toHaveBeenCalledTimes(1);
  });
});
