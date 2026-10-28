"use client";

import type { ReactNode } from "react";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";

export default function ProductEditorFields({
  children,
  disabled = false,
}: {
  children: ReactNode;
  disabled?: boolean;
}) {
  const { canEdit, state } = useProductEditor();
  const blocked = disabled || !canEdit || state.busy;
  return (
    <fieldset
      disabled={blocked}
      inert={blocked ? true : undefined}
      className="min-w-0"
    >
      {children}
    </fieldset>
  );
}
