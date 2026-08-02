import { apiClient } from "../index";
import { ENDPOINTS } from "@/constants/api";
import type { MeResponse } from "./me";

export interface UpdateProfileRequest {
  FirstName?: string;
  LastName?: string;
  NationalCode?: string;
  Phone?: string;
  BirthDate?: string;
  Sex?: string;
}

export const updateProfile = async (data: UpdateProfileRequest): Promise<MeResponse> => {
  const endpoint = `${ENDPOINTS.USER.ME}`;
  const response = await apiClient.put(endpoint, data);

  return response as any;
};
