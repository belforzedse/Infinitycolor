import type { Metadata } from "next";
import "../print/print.css";
import "./print.css";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "چاپ بارکد آنیپو",
  description: "صفحه چاپ بارکد آنیپو",
};

export default function AnipoBarcodePrintLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fa" dir="rtl">
      <body className="bg-white">{children}</body>
    </html>
  );
}
