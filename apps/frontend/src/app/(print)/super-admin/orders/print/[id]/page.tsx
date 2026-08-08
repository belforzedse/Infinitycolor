import { Suspense } from "react";
import PrintOrderPageClient from "./PrintOrderPageClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <PrintOrderPageClient />
    </Suspense>
  );
}
