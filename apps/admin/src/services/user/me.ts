import {
  CHECKOUT_MAX_RETRIES,
  CHECKOUT_REQUEST_TIMEOUT_MS,
  ENDPOINTS,
} from "@/constants/api"; // removed unused: HTTP_STATUS
import { handleAuthErrors } from "@/utils/auth";
import type { ApiError } from "@/types/api";
import { apiClient } from "@/lib/api-client";
export interface MeResponse {
  Bio: string | null;
  BirthDate: string | null;
  FirstName: string;
  IsActive: boolean;
  IsVerified: boolean;
  LastName: string;
  NationalCode: string | null;
  Phone: string;
  Sex: boolean | string | null;
  createdAt: string;
  id: number;
  updatedAt: string;
  isAdmin?: boolean;
  UserName?: string;
  roleName?: string | null;
  Email?: string | null;
  email?: string | null;
  confirmed?: boolean;
  effectivePermissions?: string[];
}

export type UpdateMePayload = Pick<
  MeResponse,
  "FirstName" | "LastName" | "NationalCode" | "BirthDate" | "Sex" | "Bio"
>;

type MaybeApiResponse<T> = T | { data: T };
function hasData<T>(p: unknown): p is { data: T } {
  return typeof p === "object" && p !== null && "data" in (p as Record<string, unknown>);
}

export const me = async (requireAdmin: boolean = false): Promise<MeResponse> => {

  const endpoint = `${ENDPOINTS.USER.ME}`;
  try {
    const response = await apiClient.get<MeResponse>(endpoint, {
      // Force no caching for admin checks to ensure fresh role data
      cache: requireAdmin ? 'no-store' : 'default',
      timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
      retries: CHECKOUT_MAX_RETRIES,
    });

    // Get the actual response data regardless of shape
    const payload = response as MaybeApiResponse<MeResponse>;
    const userData: MeResponse = hasData<MeResponse>(payload)
      ? payload.data
      : (payload as MeResponse);

    // Only enforce admin check when explicitly required
    if (requireAdmin) {
      const rolesUnknown = (userData as unknown as { roles?: unknown }).roles;
      const hasAdminRole = Array.isArray(rolesUnknown)
        ? rolesUnknown.some((r: unknown) => {
            if (typeof r === "string") return r === "admin";
            if (typeof r === "object" && r && "name" in (r as Record<string, unknown>)) {
              const name = (r as { name?: unknown }).name;
              return name === "admin";
            }
            return false;
          })
        : false;
      const isAdmin =
        !!(userData as { isAdmin?: boolean }).isAdmin ||
        !!(userData as unknown as { IsAdmin?: boolean }).IsAdmin ||
        hasAdminRole;
      handleAuthErrors(null, isAdmin);
    }

    return userData;
  } catch (error: unknown) {
    // Handle authentication errors and redirect if needed
    handleAuthErrors(error as ApiError);

    throw error;
  }
};

export const updateMe = async (payload: UpdateMePayload): Promise<MeResponse> => {
  const response = await apiClient.put<MeResponse>(ENDPOINTS.USER.ME, payload, {
    cache: "no-store",
    timeout: CHECKOUT_REQUEST_TIMEOUT_MS,
    retries: 0,
  });
  return response.data;
};
