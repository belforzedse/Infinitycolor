"use client";

import RemoveActionButton from "@/components/SuperAdmin/Table/Cells/RemoveActionButton";
import { useCan } from "@/hooks/useCan";
import {
  restoreProduct,
  softDeleteProduct,
} from "@/services/super-admin/product/removal";

/**
 * Products' recycle-bin controls.
 *
 * Exists as a component rather than props threaded through the column
 * definitions because `columns` in ./table.tsx is a module-level const, so no
 * hook — `useCan` included — can run inside the cell. Resolving the capability
 * here mirrors how RemoveActionButton already resolves hard delete for itself.
 *
 * Removal goes through the dedicated endpoints instead of the shared
 * `PUT /products/:id { removedAt }` default: `removedAt` is outside the
 * backend's operational field allowlist, so that path 400s for every
 * non-Superadmin.
 */
export default function ProductRemoveActionButton({
  id,
  isRemoved,
}: {
  id: string;
  isRemoved: boolean;
}) {
  const canSoftDelete = useCan("product.softDelete");
  const canRestore = useCan("product.restore");

  return (
    <RemoveActionButton
      isRemoved={isRemoved}
      id={id}
      apiUrl="/products"
      testIdPrefix="admin-product"
      canSoftDelete={canSoftDelete}
      canRestore={canRestore}
      onSoftDelete={softDeleteProduct}
      onRestore={restoreProduct}
    />
  );
}
