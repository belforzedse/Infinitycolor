"use client";

import { useCurrentUser } from "@/hooks/useCurrentUser";
import SuperAdminActivityLogs from "./SuperAdminActivityLogs";

type ProductActivityLogsProps = {
  productId?: string | number;
  title: string;
  pageSize?: number;
  hideHeader?: boolean;
};

const isSuperadminRole = (roleName?: string | null) =>
  (roleName ?? "").trim().toLowerCase() === "superadmin";

export default function ProductActivityLogs({
  productId,
  title,
  pageSize = 20,
  hideHeader,
}: ProductActivityLogsProps) {
  const { user, roleName, isLoading } = useCurrentUser();

  if (isLoading || !user || !isSuperadminRole(roleName)) {
    return null;
  }

  return (
    <SuperAdminActivityLogs
      resourceType="product"
      resourceId={productId}
      pageSize={pageSize}
      title={title}
      hideHeader={hideHeader}
    />
  );
}
