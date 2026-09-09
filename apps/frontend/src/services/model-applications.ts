import { getStrapiServerUrl } from "@repo/api";
import { centralAuth } from "@/lib/central-auth";

export const MODEL_APPLICATION_MAX_PHOTO_BYTES = 5 * 1024 * 1024;
export const MODEL_APPLICATION_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";

export type SubmitModelApplicationResult = {
  applicationId: string;
  createdAt: string;
  replayed: boolean;
};

export class ModelApplicationSubmitError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ModelApplicationSubmitError";
  }
}

export async function submitModelApplication(
  formData: FormData,
): Promise<SubmitModelApplicationResult> {
  const token = await centralAuth.tokenManager.getToken().catch(() => null);
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${getStrapiServerUrl()}/model-applications`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: formData,
      credentials: "include",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as
      | {
          data?: SubmitModelApplicationResult;
          error?: { message?: string };
        }
      | null;
    if (!response.ok) {
      throw new ModelApplicationSubmitError(
        payload?.error?.message || "ارسال درخواست انجام نشد. دوباره تلاش کنید.",
        response.status,
      );
    }
    if (!payload?.data?.applicationId) {
      throw new ModelApplicationSubmitError("ارسال درخواست انجام نشد. دوباره تلاش کنید.");
    }
    return payload.data;
  } catch (error) {
    if (error instanceof ModelApplicationSubmitError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelApplicationSubmitError("ارسال درخواست طولانی شد. دوباره تلاش کنید.");
    }
    throw new ModelApplicationSubmitError("ارسال درخواست انجام نشد. دوباره تلاش کنید.");
  } finally {
    window.clearTimeout(timeoutId);
  }
}
