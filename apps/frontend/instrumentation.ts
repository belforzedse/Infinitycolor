export async function register() {
  if (process.env.E2E_DISABLE_SENTRY === "1") {
    return;
  }

  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

type CaptureRequestError = typeof import("@sentry/nextjs").captureRequestError;

export const onRequestError: CaptureRequestError = async (...args) => {
  if (process.env.E2E_DISABLE_SENTRY === "1") {
    return;
  }

  try {
    const Sentry = await import("@sentry/nextjs");
    const { applyCatalogRscSentryScope } = await import("./src/lib/sentry-catalog-rsc");
    const [error, , errorContext] = args;
    return await Sentry.withScope((scope) => {
      applyCatalogRscSentryScope(scope, error, errorContext);
      return Sentry.captureRequestError(...args);
    });
  } catch {
    // Reporting failure must never replace the server render's original error.
  }
};
