import { Suspense } from "react";
import BulkPrintPageClient from "./BulkPrintPageClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <BulkPrintPageClient />
    </Suspense>
  );
}
