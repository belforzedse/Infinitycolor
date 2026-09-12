import { apiClient } from "../index";
import { ENDPOINTS } from "@/constants/api";
import type { MeResponse } from "./me";

/**
 * Mirrors the backend allowlist in `apps/backend/src/api/auth/controllers/auth.ts`.
 * Any key outside it makes the whole request fail with `PROFILE_FIELDS_NOT_ALLOWED`, so
 * `Phone` deliberately does not appear here -- the phone number is not self-editable.
 */
export interface UpdateProfileRequest {
  FirstName?: string;
  LastName?: string;
  NationalCode?: string | null;
  BirthDate?: string | null;
  Sex?: "male" | "female" | null;
  Bio?: string | null;
}

export const updateProfile = async (data: UpdateProfileRequest): Promise<MeResponse> => {
  const endpoint = `${ENDPOINTS.USER.ME}`;
  const response = await apiClient.put(endpoint, data);

  return response as any;
};
