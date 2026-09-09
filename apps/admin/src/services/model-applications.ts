import { apiClient } from "@/lib/api-client";

export type ModelApplicationStatus = "new" | "in_review" | "contacted";

export type ModelApplicationPhoto = {
  url: string;
  name: string;
};

export type ModelApplicationSummary = {
  applicationId: string;
  fullName: string;
  phone: string;
  email: string | null;
  age: number;
  city: string | null;
  status: ModelApplicationStatus;
  submittedAt: string;
  updatedAt: string;
  version: number;
};

export type ModelApplicationDetail = ModelApplicationSummary & {
  heightCm: number | null;
  experience: string | null;
  sourcePath: string | null;
  reporterUserId: number | null;
  photoOne: ModelApplicationPhoto | null;
  photoTwo: ModelApplicationPhoto | null;
};

export type ModelApplicationFilters = {
  search?: string;
  status?: ModelApplicationStatus | "";
  from?: string;
  to?: string;
};

function queryString(
  filters: ModelApplicationFilters & { cursor?: string; limit?: number },
): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listModelApplications(
  filters: ModelApplicationFilters & { cursor?: string; limit?: number },
  signal?: AbortSignal,
) {
  const response = await apiClient.get<{
    items: ModelApplicationSummary[];
    hasMore: boolean;
    nextCursor: string | null;
  }>(`/model-applications/admin${queryString(filters)}`, {
    cache: "no-cache",
    signal,
  });
  return response.data;
}

export async function getModelApplication(applicationId: string, signal?: AbortSignal) {
  const response = await apiClient.get<ModelApplicationDetail>(
    `/model-applications/admin/${encodeURIComponent(applicationId)}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function setModelApplicationStatus(
  applicationId: string,
  status: ModelApplicationStatus,
  expectedVersion: number,
) {
  const response = await apiClient.patch<ModelApplicationDetail>(
    `/model-applications/admin/${encodeURIComponent(applicationId)}/status`,
    { status, expectedVersion },
    { retries: 0, cache: "no-store" },
  );
  return response.data;
}
