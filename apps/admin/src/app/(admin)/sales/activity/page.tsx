import AuditReport from "@/components/SuperAdmin/Audit/AuditReport";
import SalesPage from "../_components/SalesPage";

export default function AdminActivityReportPage() {
  return (
    <SalesPage title="حسابرسی و فعالیت مدیران">
      <AuditReport />
    </SalesPage>
  );
}
