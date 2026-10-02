import { fetchCatalogJson } from "../catalog-transport";
import * as Sentry from "@sentry/nextjs";

jest.mock("@sentry/nextjs", () => ({ isEnabled: () => true, logger: { info: jest.fn() } }));
const response = (status = 200, data: unknown = { data: [] }) =>
  ({
    ok: status === 200,
    status,
    headers: new Headers({ "x-request-id": "request-123" }),
    json: jest.fn().mockResolvedValue(data),
  }) as unknown as Response;
beforeEach(() => {
  global.fetch = jest.fn();
  jest.clearAllMocks();
});
afterEach(() => jest.useRealTimers());

it("recovers a connection timeout once without losing cancellation or cache options", async () => {
  jest
    .mocked(fetch)
    .mockRejectedValueOnce(
      Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } }),
    )
    .mockResolvedValueOnce(response());
  const signal = new AbortController().signal;
  await expect(
    fetchCatalogJson("http://api.test/products", { signal, next: { revalidate: 120 } }, "plp"),
  ).resolves.toMatchObject({ attempts: 2, requestId: "request-123", data: { data: [] } });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith(
    "http://api.test/products",
    expect.objectContaining({ next: { revalidate: 120 }, signal: expect.any(AbortSignal) }),
  );
  expect(Sentry.logger.info).toHaveBeenCalledWith(
    "catalog.recovery",
    expect.objectContaining({ outcome: "recovered", retry_count: 1 }),
  );
});
it.each([502, 503, 504])("retries %s once", async (status) => {
  jest.mocked(fetch).mockResolvedValue(response(status));
  await expect(fetchCatalogJson("http://api.test/products")).resolves.toMatchObject({
    response: { status },
    attempts: 2,
  });
  expect(fetch).toHaveBeenCalledTimes(2);
});
it.each([400, 401, 403, 404, 429, 500])(
  "does not retry %s or consume its error body",
  async (status) => {
    const res = response(status);
    jest.mocked(fetch).mockResolvedValue(res);
    await fetchCatalogJson("http://api.test/products");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(res.json).not.toHaveBeenCalled();
  },
);
it("retains malformed JSON as actionable without retry", async () => {
  const res = response();
  jest.mocked(res.json).mockRejectedValue(new SyntaxError("private response body"));
  jest.mocked(fetch).mockResolvedValue(res);
  const error = await fetchCatalogJson("http://api.test/products").catch((e) => e);
  expect(error).toMatchObject({
    failureStage: "response_json",
    status: 200,
    requestId: "request-123",
    cause: { name: "SyntaxError" },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(error)).not.toContain("private");
});
it("bounds a hung body and its retry to fifteen seconds", async () => {
  jest.useFakeTimers();
  const res = response();
  jest.mocked(res.json).mockImplementation(() => new Promise(() => {}));
  jest.mocked(fetch).mockResolvedValue(res);
  const pending = fetchCatalogJson("http://api.test/products").catch((e) => e);
  await jest.advanceTimersByTimeAsync(15_000);
  expect(await pending).toMatchObject({
    attempts: 2,
    failureStage: "response_json",
    cause: { code: "ETIMEDOUT" },
  });
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(jest.getTimerCount()).toBe(0);
});
it("forwards an explicit caller cancellation without retry", async () => {
  const controller = new AbortController();
  jest.mocked(fetch).mockImplementation(() => new Promise(() => {}));
  const pending = fetchCatalogJson("http://api.test/products", { signal: controller.signal }).catch(
    (e) => e,
  );
  controller.abort();
  expect(await pending).toMatchObject({ knownCancellation: true, attempts: 1 });
  expect(fetch).toHaveBeenCalledTimes(1);
});
it("refuses mutations before fetching", async () => {
  await expect(fetchCatalogJson("http://api.test/products", { method: "POST" })).rejects.toThrow(
    "GET",
  );
  expect(fetch).not.toHaveBeenCalled();
});
