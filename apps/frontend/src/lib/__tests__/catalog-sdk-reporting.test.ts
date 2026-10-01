/** @jest-environment node */
import * as Sentry from "@sentry/nextjs";
import { onRequestError } from "../../../instrumentation";
import { PLPProductsError } from "@/services/product/plp";
import { applyCatalogRscEvent } from "../sentry-catalog-rsc";

it("sends one digest-correlated server event with redacted linked causes through the installed SDK", async () => {
  const envelopes: unknown[] = [];
  Sentry.init({
    dsn: "https://public@telemetry.invalid/1",
    defaultIntegrations: false,
    integrations: [Sentry.linkedErrorsIntegration()],
    transport: () => ({
      send: async (envelope) => {
        envelopes.push(envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
    beforeSend: applyCatalogRscEvent,
  });
  try {
    const cause = new TypeError(
      "private response https://user:password@host/products?search=secret",
    );
    cause.cause = Object.assign(new Error("customer email and socket details"), {
      code: "ECONNRESET",
    });
    const error = new PLPProductsError("Unable to load products", "FETCH_FAILED", undefined, {
      stage: "request",
      cause,
    });
    Object.assign(error, { digest: "4073695856" });
    await onRequestError(
      error,
      { path: "/plp/category/example", method: "GET", headers: {} },
      { routerKind: "App Router", routePath: "/plp/category/[slug]", routeType: "render" },
    );
    await Sentry.flush(1000);
    const events = (envelopes as Array<[unknown, Array<[{ type: string }, Sentry.Event]>]>).flatMap(
      ([, items]) => items.filter(([header]) => header.type === "event").map(([, event]) => event),
    );
    expect(events).toHaveLength(1);
    expect(events[0].tags).toMatchObject({
      next_error_digest: "4073695856",
      catalog_failure_stage: "request",
      catalog_cause_code: "ECONNRESET",
    });
    expect(events[0].fingerprint).toEqual(["catalog-rsc", "plp", "FETCH_FAILED"]);
    expect(events[0].exception?.values).toHaveLength(3);
    expect(JSON.stringify(events)).not.toMatch(/password|secret|customer email|socket details/);
  } finally {
    await Sentry.close(1000);
  }
});
