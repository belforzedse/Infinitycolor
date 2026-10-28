import { useState, useCallback } from "react";
import VariablesFeatures from "./Details/Features";
import ProductVariables from "./Details/Variable";

export default function Variables({
  productId,
  refreshKey: externalRefreshKey = 0,
  onVariationsChanged,
}: {
  productId: number;
  /** Bumped by the product page when a publish cascades to the variations. */
  refreshKey?: number;
  /** Told when variations were generated, re-coloured or deleted here. */
  onVariationsChanged?: () => void;
}) {
  const [refreshKey, setRefreshKey] = useState(0);

  const [axesRefreshKey, setAxesRefreshKey] = useState(0);

  const handleVariationsGenerated = useCallback(() => {
    setRefreshKey((prev) => prev + 1);
    onVariationsChanged?.();
  }, [onVariationsChanged]);

  // A variation edited or deleted in the list can change which colours, sizes
  // and models the product is built from, so the features table re-reads them.
  const handleVariationsChanged = useCallback(() => {
    setAxesRefreshKey((prev) => prev + 1);
    onVariationsChanged?.();
  }, [onVariationsChanged]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex w-full flex-col gap-4 overflow-hidden rounded-xl bg-white">
        <VariablesFeatures
          productId={productId}
          onVariationsGenerated={handleVariationsGenerated}
          axesRefreshKey={axesRefreshKey}
        />
        <ProductVariables
          productId={productId}
          refreshKey={refreshKey + externalRefreshKey}
          onVariationsChanged={handleVariationsChanged}
        />
      </div>
      {/* <MetaOptions /> */}
    </div>
  );
}
