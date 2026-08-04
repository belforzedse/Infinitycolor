import type { Metadata } from "next";
import AdminAccountClient from "./AdminAccountClient";

export const metadata: Metadata = { title: "حساب مدیریتی" };

export default function AdminAccountPage() {
  return <AdminAccountClient />;
}
