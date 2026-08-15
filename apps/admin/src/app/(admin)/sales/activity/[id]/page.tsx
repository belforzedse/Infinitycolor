import { redirect } from "next/navigation";

export default async function AuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/sales/activity?event=${encodeURIComponent(id)}`);
}
