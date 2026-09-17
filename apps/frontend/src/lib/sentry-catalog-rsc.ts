type CatalogErrorContext = {
  routePath?: string;
};

type CatalogErrorLike = {
  name?: string;
  message?: string;
  code?: unknown;
};

type SentryScopeLike = {
  setTag: (key: string, value: string) => void;
  setFingerprint: (fingerprint: string[]) => void;
};

/** Matches Sentry `Primitive` so `beforeSend(event: ErrorEvent)` can return `T`. */
type SentryTagValue = string | number | boolean | bigint | symbol | null | undefined;

type SentryEventLike = {
  fingerprint?: string[];
  tags?: { [key: string]: SentryTagValue };
  transaction?: string;
  exception?: {
    values?: Array<{ type?: string; value?: string }>;
  };
};

type SentryHintLike = {
  originalException?: unknown;
};

function catalogErrorFields(error: unknown): CatalogErrorLike {
  if (!error || typeof error !== "object") return {};
  const record = error as CatalogErrorLike;
  return {
    name: typeof record.name === "string" ? record.name : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
    code: record.code,
  };
}

function catalogErrorCode(error: unknown): string | undefined {
  const { code } = catalogErrorFields(error);
  return typeof code === "string" && code ? code : undefined;
}

export function requestRoutePath(errorContext: unknown): string | undefined {
  if (!errorContext || typeof errorContext !== "object") return undefined;
  if (!("routePath" in errorContext)) return undefined;
  const routePath = (errorContext as CatalogErrorContext).routePath;
  return typeof routePath === "string" && routePath ? routePath : undefined;
}

/**
 * Split catalog RSC failures so PLP timeouts and PDP empty-product throws
 * stop sharing one Sentry fingerprint. Only names/codes, never request URLs.
 */
export function catalogRscFingerprint(
  error: unknown,
  errorContext?: CatalogErrorContext,
): string[] | undefined {
  const { name, message } = catalogErrorFields(error);
  const code = catalogErrorCode(error);
  const routePath = errorContext?.routePath || "";

  if (name === "PLPProductsError" || (routePath.includes("/plp") && name === "PLPProductsError")) {
    return ["catalog-rsc", "plp", code || "PLPProductsError"];
  }
  if (message === "PRODUCT_DATA_UNAVAILABLE") {
    return ["catalog-rsc", "pdp", "PRODUCT_DATA_UNAVAILABLE"];
  }
  return undefined;
}

function catalogRscFingerprintFromEvent(event: SentryEventLike): string[] | undefined {
  const first = event.exception?.values?.[0];
  const type = first?.type || "";
  const value = first?.value || "";
  if (type === "PLPProductsError") {
    return ["catalog-rsc", "plp", "PLPProductsError"];
  }
  if (value === "PRODUCT_DATA_UNAVAILABLE") {
    return ["catalog-rsc", "pdp", "PRODUCT_DATA_UNAVAILABLE"];
  }
  return undefined;
}

export function applyCatalogRscSentryScope(
  scope: SentryScopeLike,
  error: unknown,
  errorContext?: unknown,
): void {
  const { name } = catalogErrorFields(error);
  if (name) scope.setTag("error_name", name);
  const code = catalogErrorCode(error);
  if (code) scope.setTag("catalog_error_code", code);
  const routePath = requestRoutePath(errorContext);
  if (routePath) scope.setTag("route_path", routePath);
  const fingerprint = catalogRscFingerprint(error, { routePath });
  if (fingerprint) scope.setFingerprint(fingerprint);
}

export function applyCatalogRscEvent<T extends SentryEventLike>(
  event: T,
  hint?: SentryHintLike,
): T {
  const routePath = event.transaction;
  const fromError = catalogRscFingerprint(hint?.originalException, { routePath });
  const fingerprint = fromError || catalogRscFingerprintFromEvent(event);
  if (fingerprint) {
    event.fingerprint = fingerprint;
  }

  const { name } = catalogErrorFields(hint?.originalException);
  const code = catalogErrorCode(hint?.originalException);
  event.tags = event.tags || {};
  if (name && !event.tags.error_name) event.tags.error_name = name;
  if (code && !event.tags.catalog_error_code) event.tags.catalog_error_code = code;
  if (routePath && !event.tags.route_path) event.tags.route_path = routePath;
  return event;
}
