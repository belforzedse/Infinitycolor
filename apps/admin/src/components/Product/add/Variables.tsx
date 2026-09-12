import { useState, useCallback } from "react";
import VariablesFeatures from "./Details/Features";
import ProductVariables from "./Details/Variable";

export default function Variables({
  productId,
  refreshKey: externalRefreshKey = 0,
}: {
  productId: number;
  /** Bumped by the product page when a publish cascades to the variations. */
  refreshKey?: number;
}) {
  const [refreshKey, setRefreshKey] = useState(0);

  const handleVariationsGenerated = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
  }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full flex-col gap-4 overflow-hidden rounded-xl bg-white">
        <VariablesFeatures
          productId={productId}
          onVariationsGenerated={handleVariationsGenerated}
        />
        <ProductVariables productId={productId} refreshKey={refreshKey + externalRefreshKey} />
      </div>
      {/* <MetaOptions /> */}
    </div>
  );
}
