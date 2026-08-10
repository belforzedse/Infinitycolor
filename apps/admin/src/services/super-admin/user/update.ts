import { apiClient } from "@/lib/api-client";

type UpdateAdminUserInput = {
  id: string;
  profile: Record<string, unknown>;
  user: {
    role?: number;
    IsActive: boolean;
  };
};

/**
 * Profile fields need Superadmin access, so persist them before a possible
 * self-demotion. The canonical plugin role is intentionally the final write.
 */
export async function updateAdminUser(
  input: UpdateAdminUserInput,
): Promise<void> {
  await apiClient.put(`/sp/local-users/${input.id}`, input.profile, {
    suppressAuthRedirect: true,
  });
  await apiClient.put(`/users/${input.id}`, input.user, {
    suppressAuthRedirect: true,
  });
}
