import { apiClient } from "@/services";

export const PRODUCT_PUBLICATION_TIMEZONE = "Asia/Tehran";

export type ProductPublicationAction =
  | "schedule"
  | "publish-now"
  | "cancel"
  | "retry"
  | "unpublish";

export type ProductPublicationResponse = {
  id: number;
  Status: "Active" | "InActive" | "Scheduled";
  scheduledPublishAt: string | null;
  scheduledPublishTimezone: string | null;
  scheduledPublishRevision: number;
  publicationRevision: number;
  queueState: "queued" | "pending-reconciliation" | "not-required";
  changed: boolean;
};

export async function changeProductPublication(
  productId: string | number,
  input: {
    action: ProductPublicationAction;
    publishAt?: string;
    timezone?: string;
  },
): Promise<ProductPublicationResponse> {
  const response = await apiClient.post<ProductPublicationResponse>(
    `/products/${productId}/publication`,
    {
      data: {
        ...input,
        ...(input.action === "schedule"
          ? { timezone: input.timezone || PRODUCT_PUBLICATION_TIMEZONE }
          : {}),
      },
    },
    { retries: 0, timeout: 20_000 },
  );
  return response.data as ProductPublicationResponse;
}
