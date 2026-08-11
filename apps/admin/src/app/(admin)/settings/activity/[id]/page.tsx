import { redirect } from "next/navigation";

export default async function LegacyAuditDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/settings/activity?event=${encodeURIComponent(id)}`);
}
