/** @jest-environment node */
import { channel } from "node:diagnostics_channel";
import { catalogWireShape, installCatalogWireDiagnostics } from "../catalog-wire-diagnostics";
import { logDiagnostic } from "../diagnostic-log";
jest.mock("@/constants/api", () => ({ getStrapiServerUrl: () => "http://api.test:1337/api" }));
jest.mock("../diagnostic-log", () => ({ logDiagnostic: jest.fn() }));
afterEach(() => jest.clearAllMocks());
it("counts transmitted application and trace bytes separately without retaining values", () => {
  const shape = catalogWireShape(
    "/api/products?search=secret",
    "GET /api/products?search=secret HTTP/1.1\r\nX-App: private\r\nBaggage: trace-secret\r\n\r\n",
  );
  expect(shape).toMatchObject({
    request_target_bytes: 27,
    application_header_bytes: 16,
    trace_header_bytes: 23,
  });
  expect(JSON.stringify(shape)).not.toMatch(/secret|private|search/);
});
it("bounds terminal receipts, ignores unrelated origins/operations and cleans up subscriptions", () => {
  const cleanup = installCatalogWireDiagnostics();
  const sending = channel("undici:client:sendHeaders");
  const responses = channel("undici:request:headers");
  try {
    for (let i = 0; i < 25; i += 1) {
      const request = {
        method: "GET",
        origin: "http://api.test:1337",
        path: "/api/products?secret",
      };
      sending.publish({
        request,
        headers: "GET /api/products?secret HTTP/1.1\r\nBaggage: private\r\n\r\n",
      });
      responses.publish({ request, response: { statusCode: 431 } });
    }
    for (const request of [
      { method: "POST", origin: "http://api.test:1337", path: "/api/products" },
      { method: "GET", origin: "https://elsewhere.test", path: "/api/products" },
    ]) {
      sending.publish({ request, headers: "GET / HTTP/1.1\r\n\r\n" });
      responses.publish({ request, response: { statusCode: 431 } });
    }
    expect(logDiagnostic).toHaveBeenCalledTimes(20);
    expect(JSON.stringify(jest.mocked(logDiagnostic).mock.calls)).not.toMatch(/secret|private/);
  } finally {
    cleanup();
  }
});

it("retains only a validated response correlation and never interrupts transport when logging throws", () => {
  const cleanup = installCatalogWireDiagnostics();
  const request = { method: "GET", origin: "http://api.test:1337", path: "/api/products" };
  try {
    channel("undici:client:sendHeaders").publish({
      request,
      headers: "GET /api/products HTTP/1.1\r\nAccept: application/json\r\n\r\n",
    });
    channel("undici:request:headers").publish({
      request,
      response: {
        statusCode: 431,
        headers: [
          Buffer.from("x-request-id"),
          Buffer.from("receipt-431"),
          Buffer.from("set-cookie"),
          Buffer.from("private"),
        ],
      },
    });
    expect(logDiagnostic).toHaveBeenCalledWith(
      "catalog.recovery",
      expect.objectContaining({ request_id: "receipt-431" }),
    );
    jest.mocked(logDiagnostic).mockImplementationOnce(() => {
      throw new Error("telemetry offline");
    });
    channel("undici:client:sendHeaders").publish({
      request,
      headers: "GET /api/products HTTP/1.1\r\n\r\n",
    });
    expect(() =>
      channel("undici:request:headers").publish({ request, response: { statusCode: 503 } }),
    ).not.toThrow();
    expect(JSON.stringify(jest.mocked(logDiagnostic).mock.calls)).not.toContain("private");
  } finally {
    cleanup();
  }
});
