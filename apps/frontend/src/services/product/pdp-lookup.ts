import { ENDPOINTS, getStrapiServerUrl } from "@/constants/api";
import { PRODUCT_TAG, productSlugTag } from "@/constants/cacheTags";
import type { ProductDetail } from "./product";
import { normalizeProductDetail } from "@/app/(product)/pdp/normalizeProductDetail";
import { fetchCatalogJson, CatalogTransportError } from "@/lib/catalog-transport";
import { redactCatalogCause, type CatalogFailureStage } from "@/lib/catalog-error-diagnostics";
const PDP_PRODUCT_SHELL_QUERY = "view=shell";
type ProductLookupFailure = "missing" | "unavailable";

export type ProductLookupResult = {
  product: ProductDetail | null;
  errorDetails?: {
    message?: string;
    status?: number;
    endpoint?: string;
    failure?: ProductLookupFailure;
    failureStage?: CatalogFailureStage;
    cause?: unknown;
    requestId?: string;
    error?: PdpProductUnavailableError;
  };
};

export class PdpProductUnavailableError extends Error {
  readonly failureStage: CatalogFailureStage;
  readonly status?: number;
  readonly requestId?: string;
  constructor(public readonly details: NonNullable<ProductLookupResult["errorDetails"]> = {}) {
    super(
      "PRODUCT_DATA_UNAVAILABLE",
      details.cause
        ? { cause: redactCatalogCause(details.cause, details.failureStage ?? "request") }
        : undefined,
    );
    this.details = { ...details, cause: this.cause };
    this.name = "PdpProductUnavailableError";
    this.failureStage = details.failureStage ?? "request";
    this.status = details.status;
    this.requestId = details.requestId;
  }
}

export const fetchPdpProduct = async (
  decodedSlug: string,
  revalidateSeconds: number,
): Promise<ProductLookupResult> => {
  const apiUrl = `${getStrapiServerUrl()}${ENDPOINTS.PRODUCT.PRODUCT}/by-slug/${encodeURIComponent(decodedSlug)}?${PDP_PRODUCT_SHELL_QUERY}`;
  try {
    const { response, data, requestId } = await fetchCatalogJson<{ data?: unknown }>(
      apiUrl,
      {
        headers: { Accept: "application/json" },
        next: { revalidate: revalidateSeconds, tags: [PRODUCT_TAG, productSlugTag(decodedSlug)] },
      },
      "pdp",
    );
    if (!response.ok)
      return {
        product: null,
        errorDetails: {
          message: "Product service unavailable",
          status: response.status,
          failure: response.status === 404 ? "missing" : "unavailable",
          failureStage: "response_status",
          requestId,
        },
      };
    const product = normalizeProductDetail(data?.data);
    if (!product)
      return {
        product: null,
        errorDetails: {
          message: "Invalid product response",
          status: response.status,
          failure: "unavailable",
          failureStage: "response_normalization",
          requestId,
        },
      };
    return { product };
  } catch (cause) {
    return {
      product: null,
      errorDetails: {
        message: "Product lookup temporarily unavailable",
        failure: "unavailable",
        failureStage:
          cause instanceof CatalogTransportError ? cause.failureStage : "response_normalization",
        status: cause instanceof CatalogTransportError ? cause.status : undefined,
        requestId: cause instanceof CatalogTransportError ? cause.requestId : undefined,
        cause:
          cause instanceof CatalogTransportError
            ? cause.cause
            : redactCatalogCause(cause, "response_normalization"),
      },
    };
  }
};
