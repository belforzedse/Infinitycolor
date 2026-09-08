import type { Metadata } from "next";
import { peydaFanum } from "@repo/fonts";
import "@repo/ui/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "احراز هویت | اینفینیتی کالر",
    template: "%s | اینفینیتی کالر",
  },
  description: "ورود یا ثبت‌نام در اینفینیتی کالر",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fa" dir="rtl" className={peydaFanum.variable}>
      <body>{children}</body>
    </html>
  );
}
