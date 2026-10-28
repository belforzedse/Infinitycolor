/** @jest-environment node */
import { fetchPdpProduct, PdpProductUnavailableError } from "../pdp-lookup";
import { normalizeProductDetail } from "@/app/(product)/pdp/normalizeProductDetail";
jest.mock("@/app/(product)/pdp/normalizeProductDetail", () => ({
  normalizeProductDetail: jest.fn(),
}));
jest.mock("@/lib/diagnostic-log", () => ({ logDiagnostic: jest.fn() }));
beforeEach(() => {
  global.fetch = jest.fn();
  jest.clearAllMocks();
});

it("loads numeric product URLs by ID only after a genuine slug 404", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValueOnce(new Response("", { status: 404 }))
    .mockResolvedValueOnce(new Response('{"data":{"id":42}}'));
  const product = { id: 42 } as any;
  jest.mocked(normalizeProductDetail).mockReturnValueOnce(product);
  expect(await fetchPdpProduct("42", 30)).toEqual({ product });
  expect(fetch).toHaveBeenCalledTimes(2);
  const url = new URL(String(jest.mocked(fetch).mock.calls[1][0]));
  expect(url.pathname).toMatch(/\/products\/42$/);
  expect([...url.searchParams.values()]).toEqual(
    expect.arrayContaining(["ColorGalleries.color", "ColorGalleries.Images"]),
  );
});

it("does not mask a numeric slug service failure with an ID lookup", async () => {
  jest.mocked(fetch).mockResolvedValue(new Response("", { status: 503 }));
  expect(await fetchPdpProduct("42", 30)).toMatchObject({
    errorDetails: { failure: "unavailable", status: 503 },
  });
  expect(jest.mocked(fetch).mock.calls.every(([url]) => String(url).includes("/by-slug/42"))).toBe(
    true,
  );
});
it("preserves a genuine 404 without parsing or retrying", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(
      new Response("private body", { status: 404, headers: { "x-request-id": "request-404" } }),
    );
  const result = await fetchPdpProduct("missing", 30);
  expect(result).toMatchObject({
    product: null,
    errorDetails: {
      failure: "missing",
      status: 404,
      failureStage: "response_status",
      requestId: "request-404",
    },
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(normalizeProductDetail).not.toHaveBeenCalled();
});
it("keeps invalid successful payloads unavailable rather than missing", async () => {
  jest.mocked(fetch).mockResolvedValue(new Response("{}"));
  jest.mocked(normalizeProductDetail).mockReturnValue(null);
  expect(await fetchPdpProduct("broken", 30)).toMatchObject({
    errorDetails: { failure: "unavailable", failureStage: "response_normalization", status: 200 },
  });
});
it("preserves the original connection code in the single rendering failure", async () => {
  jest.mocked(fetch).mockRejectedValue(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("private address"), { code: "UND_ERR_CONNECT_TIMEOUT" }),
    }),
  );
  const result = await fetchPdpProduct("temporary", 30);
  const error = new PdpProductUnavailableError(result.errorDetails);
  expect(error.cause).toMatchObject({
    name: "TypeError",
    cause: { code: "UND_ERR_CONNECT_TIMEOUT" },
  });
  expect(error.details.cause).toBe(error.cause);
  expect(JSON.stringify(error.details)).not.toContain("private address");
  expect(fetch).toHaveBeenCalledTimes(2);
});
it("retains JSON parse stage, HTTP status and correlation without normalization", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(new Response("bad JSON", { headers: { "x-request-id": "request-json" } }));
  expect(await fetchPdpProduct("malformed", 30)).toMatchObject({
    errorDetails: {
      failureStage: "response_json",
      status: 200,
      requestId: "request-json",
      cause: { name: "SyntaxError" },
    },
  });
  expect(normalizeProductDetail).not.toHaveBeenCalled();
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("retains response correlation when normalization itself throws", async () => {
  jest
    .mocked(fetch)
    .mockResolvedValue(
      new Response('{"data":{}}', { headers: { "x-request-id": "receipt-normalization" } }),
    );
  jest.mocked(normalizeProductDetail).mockImplementationOnce(() => {
    throw new TypeError("private payload");
  });
  expect(await fetchPdpProduct("malformed", 30)).toMatchObject({
    errorDetails: {
      status: 200,
      requestId: "receipt-normalization",
      attempts: 1,
      failureStage: "response_normalization",
      requestShape: { application_header_bytes: expect.any(Number) },
      cause: { name: "TypeError" },
    },
  });
});
