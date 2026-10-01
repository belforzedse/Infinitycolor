import {
  applyCatalogRscEvent,
  applyCatalogRscSentryScope,
  catalogRscFingerprint,
} from "../sentry-catalog-rsc";

function plpFetchError() {
  const error = new Error("Unable to load products") as Error & { code: string };
  error.name = "PLPProductsError";
  error.code = "FETCH_FAILED";
  return error;
}

describe("catalog RSC Sentry fingerprints", () => {
  it("splits PLPProductsError from PDP product-unavailable throws", () => {
    expect(catalogRscFingerprint(plpFetchError(), { routePath: "/plp/category/x" })).toEqual([
      "catalog-rsc",
      "plp",
      "FETCH_FAILED",
    ]);
    expect(
      catalogRscFingerprint(new Error("PRODUCT_DATA_UNAVAILABLE"), { routePath: "/pdp/slug" }),
    ).toEqual(["catalog-rsc", "pdp", "PRODUCT_DATA_UNAVAILABLE"]);

    const named = new Error("PRODUCT_DATA_UNAVAILABLE");
    named.name = "PdpProductUnavailableError";
    expect(catalogRscFingerprint(named, { routePath: "/pdp/slug" })).toEqual([
      "catalog-rsc",
      "pdp",
      "PRODUCT_DATA_UNAVAILABLE",
    ]);
  });

  it("does not fingerprint unrelated server errors even on catalog routes", () => {
    expect(
      catalogRscFingerprint(new Error("boom"), { routePath: "/plp/category/x" }),
    ).toBeUndefined();
  });

  it("tags name, code, and route without copying the error message", () => {
    const tags: Record<string, string> = {};
    let fingerprint: string[] | undefined;
    applyCatalogRscSentryScope(
      {
        setTag: (key, value) => {
          tags[key] = value;
        },
        setFingerprint: (next) => {
          fingerprint = next;
        },
      },
      plpFetchError(),
      { routePath: "/plp/category/x" },
    );

    expect(tags).toEqual({
      error_name: "PLPProductsError",
      catalog_error_code: "FETCH_FAILED",
      route_path: "/plp/category/x",
    });
    expect(fingerprint).toEqual(["catalog-rsc", "plp", "FETCH_FAILED"]);
    expect(JSON.stringify(tags)).not.toContain("Unable to load products");
  });

  it("recovers PLP vs PDP fingerprints from redacted event payloads", () => {
    const plpEvent = applyCatalogRscEvent(
      {
        exception: { values: [{ type: "PLPProductsError", value: "[Filtered]" }] },
      },
      {},
    );
    expect(plpEvent.fingerprint).toEqual(["catalog-rsc", "plp", "PLPProductsError"]);

    const pdpEvent = applyCatalogRscEvent(
      {
        exception: { values: [{ type: "Error", value: "PRODUCT_DATA_UNAVAILABLE" }] },
      },
      {},
    );
    expect(pdpEvent.fingerprint).toEqual(["catalog-rsc", "pdp", "PRODUCT_DATA_UNAVAILABLE"]);

    const namedPdpEvent = applyCatalogRscEvent(
      {
        exception: { values: [{ type: "PdpProductUnavailableError", value: "[Filtered]" }] },
      },
      {},
    );
    expect(namedPdpEvent.fingerprint).toEqual(["catalog-rsc", "pdp", "PRODUCT_DATA_UNAVAILABLE"]);
  });

  it("preserves ErrorEvent discriminants so beforeSend can return the same event", () => {
    const event = applyCatalogRscEvent(
      {
        type: "error" as const,
        exception: { values: [{ type: "PLPProductsError", value: "[Filtered]" }] },
        tags: { sampled: true },
      },
      {},
    );
    expect(event.type).toBe("error");
    expect(event.tags?.sampled).toBe(true);
    expect(event.fingerprint).toEqual(["catalog-rsc", "plp", "PLPProductsError"]);
  });
});

it("attaches the same server digest used by client recovery reports", () => {
  const error = Object.assign(new Error("server cause"), { digest: "4073695856" });
  const scope = { setTag: jest.fn(), setFingerprint: jest.fn() };
  applyCatalogRscSentryScope(scope, error);
  expect(scope.setTag).toHaveBeenCalledWith("next_error_digest", "4073695856");
  expect(applyCatalogRscEvent({}, { originalException: error }).tags?.next_error_digest).toBe(
    "4073695856",
  );
});
