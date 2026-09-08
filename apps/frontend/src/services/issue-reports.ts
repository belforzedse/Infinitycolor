import { apiClient } from "@/lib/api-client";

export type IssueReportClientContext = {
  clientTime: string;
  timeZone: string | null;
  language: string;
  viewport: { width: number; height: number };
  screen: { width: number; height: number; pixelRatio: number };
  online: boolean;
  connectionType: string | null;
  androidHints?: { model: string | null; platformVersion: string | null };
};

export type SubmitIssueReportInput = {
  submissionId: string;
  number: string;
  issueName: string;
  description: string;
  sourcePath: string;
  locale: string;
  context: IssueReportClientContext;
};

export type SubmitIssueReportResult = {
  reportId: string;
  createdAt: string;
  replayed: boolean;
};

export async function submitIssueReport(input: SubmitIssueReportInput) {
  const response = await apiClient.post<SubmitIssueReportResult>("/issue-reports", input, {
    retries: 0,
    timeout: 12_000,
    cache: "no-store",
  });
  return response.data;
}
