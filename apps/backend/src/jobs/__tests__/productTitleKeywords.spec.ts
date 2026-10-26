import type { Strapi } from "@strapi/strapi";
import { refreshProductKeywords } from "../../api/product/services/product-title-keywords-refresh";
import { startProductKeywordsJob } from "../productTitleKeywords";

jest.mock("../../api/product/services/product-title-keywords-refresh", () => ({
  refreshProductKeywords: jest.fn(),
}));

const mockedRefresh = jest.mocked(refreshProductKeywords);
describe("startProductKeywordsJob", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedRefresh.mockReset();
    mockedRefresh.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("runs immediately, repeats after 30 minutes and stops cleanly", async () => {
    const strapi = {
      log: { error: jest.fn() },
    } as unknown as Strapi;

    const stop = startProductKeywordsJob(strapi);

    try {
      expect(mockedRefresh).toHaveBeenCalledTimes(1);
      expect(mockedRefresh).toHaveBeenCalledWith(strapi);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockedRefresh).toHaveBeenCalledTimes(2);

      await stop();

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockedRefresh).toHaveBeenCalledTimes(2);
    } finally {
      await stop();
    }
  });
  it("does not start another rebuild while one is running", async () => {
    let finishRebuild!: () => void;

    mockedRefresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishRebuild = resolve;
        }),
    );

    const strapi = {
      log: { error: jest.fn() },
    } as unknown as Strapi;

    const stop = startProductKeywordsJob(strapi);

    try {
      expect(mockedRefresh).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockedRefresh).toHaveBeenCalledTimes(1);

      finishRebuild();
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockedRefresh).toHaveBeenCalledTimes(2);
    } finally {
      finishRebuild();
      await stop();
    }
  });
  it("logs a failure and retries at the next interval", async () => {
    const error = new Error("Database unavailable");

    mockedRefresh.mockRejectedValueOnce(error);
    const logError = jest.fn();

    const strapi = {
      log: { error: logError },
    } as unknown as Strapi;

    const stop = startProductKeywordsJob(strapi);

    try {
      await jest.advanceTimersByTimeAsync(0);

      expect(mockedRefresh).toHaveBeenCalledTimes(1);

      expect(logError).toHaveBeenCalledWith("Product keywords refresh failed", error);

      await jest.advanceTimersByTimeAsync(30 * 60 * 1000);

      expect(mockedRefresh).toHaveBeenCalledTimes(2);
      expect(logError).toHaveBeenCalledTimes(1);
    } finally {
      await stop();
    }
  });
});
