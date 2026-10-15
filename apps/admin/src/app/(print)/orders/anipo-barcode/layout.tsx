import type { Metadata } from "next";
import OrderPrintPermissionGate from "@/components/SuperAdmin/Order/OrderPrintPermissionGate";
import "../print/print.css";
import "./print.css";

export const metadata: Metadata = {
  title: "چاپ بارکد آنیپو",
  description: "صفحه چاپ بارکد آنیپو",
};

export default function AnipoBarcodePrintLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <OrderPrintPermissionGate>{children}</OrderPrintPermissionGate>;
}
