import { apiClient } from "@/lib/api-client";
import { API_BASE_URL } from "@/constants/api";
import { getAccessToken } from "@/utils/auth";

export type IssueReportStatus = "new" | "in_review" | "resolved";

export type IssueReportClientContext = {
  clientTime: string | null;
  timeZone: string | null;
  language: string | null;
  viewport: { width: number; height: number } | null;
  screen: { width: number; height: number; pixelRatio: number } | null;
  online: boolean | null;
  connectionType: string | null;
  androidHints?: { model: string | null; platformVersion: string | null };
  /** The order the reporter was looking at, per the storefront widget. */
  order?: { orderId: number };
  /** Best-effort cart snapshot the storefront captured at submit time. */
  cart?: { name: string; sku: string | null; quantity: number; price: number }[];
};

export type IssueReportOrderSnapshot = {
  id: number;
  status: string | null;
  paymentGateway: string | null;
  date: string | null;
  items: {
    id: number;
    productTitle: string;
    productSku: string;
    count: number;
    perAmount: number;
  }[];
  /** null when neither side has a resolvable user; true/false otherwise. */
  reporterMatchesOrder: boolean | null;
};

export type IssueReportSummary = {
  reportId: string;
  issueName: string;
  contactNumber: string;
  descriptionPreview: string | null;
  status: IssueReportStatus;
  submittedAt: string;
  updatedAt: string;
  sourcePath: string | null;
  reporterUserId: number | null;
  version: number;
};

export type IssueReportDetail = IssueReportSummary & {
  description: string;
  clientContext: IssueReportClientContext | null;
  userAgent: string | null;
  /** Server-enriched: only present when the reporter's client_context named
   * an orderId AND that order still exists. Best-effort, so its absence
   * doesn't mean the reporter didn't reference an order. */
  order?: IssueReportOrderSnapshot;
};

export type IssueReportFilters = {
  search?: string;
  status?: IssueReportStatus | "";
  from?: string;
  to?: string;
};

function queryString(
  filters: IssueReportFilters & { cursor?: string; limit?: number },
): string {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value != null && value !== "") params.set(key, String(value));
  });
  const query = params.toString();
  return query ? `?${query}` : "";
}

export async function listIssueReports(
  filters: IssueReportFilters & { cursor?: string; limit?: number },
  signal?: AbortSignal,
) {
  const response = await apiClient.get<{
    items: IssueReportSummary[];
    hasMore: boolean;
    nextCursor: string | null;
  }>(`/issue-reports/admin${queryString(filters)}`, {
    // Revalidate without the shared client's _cb query parameter: older report
    // endpoints reject transport parameters as unknown filters.
    cache: "no-cache",
    signal,
  });
  return response.data;
}

export async function getIssueReport(reportId: string, signal?: AbortSignal) {
  const response = await apiClient.get<IssueReportDetail>(
    `/issue-reports/admin/${encodeURIComponent(reportId)}`,
    { cache: "no-store", signal },
  );
  return response.data;
}

export async function setIssueReportStatus(
  reportId: string,
  status: IssueReportStatus,
  expectedVersion: number,
) {
  const response = await apiClient.patch<IssueReportDetail>(
    `/issue-reports/admin/${encodeURIComponent(reportId)}/status`,
    { status, expectedVersion },
    { retries: 0, cache: "no-store" },
  );
  return response.data;
}

export async function downloadIssueReports(
  filters: IssueReportFilters,
): Promise<void> {
  const token = await getAccessToken();
  const response = await fetch(`${API_BASE_URL}/issue-reports/admin/export`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ filters }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error?.message || "دریافت خروجی انجام نشد.");
  }
  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = href;
  anchor.download = `issue-reports-${Date.now()}.xlsx`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(href);
}
