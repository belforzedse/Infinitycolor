import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import SizeTable from "./Table";
import SizeGuideEditor from "./SizeGuideEditor";
import { getProductSizeHelper } from "@/services/super-admin/product/size-helper/get";
import { toast } from "react-hot-toast";
import {
  normalizeSizeGuideData,
  serializeSizeGuideMatrix,
} from "@/utils/sizeGuide";
import { useProductEditor } from "@/hooks/product/ProductEditorContext";
import type { SizeGuidePayload } from "@/services/super-admin/product/update";

export type SizeGuideDraft = {
  data: any[];
  columns: { key: string; title: string }[];
  helperId?: number | null;
  saved: string;
  editing: boolean;
};
export interface SizeGuideHandle {
  getPayload: () => SizeGuidePayload | undefined;
  save: () => Promise<boolean>;
  acceptSaved: (
    helper?: { id: number; attributes: { Helper?: unknown } } | null,
  ) => void;
}
export function sizeGuideDraftPayload(
  draft?: SizeGuideDraft,
): SizeGuidePayload | undefined {
  if (!draft) return undefined;
  const Helper = serializeSizeGuideMatrix(draft.data, draft.columns);
  if (JSON.stringify(Helper) === draft.saved) return undefined;
  if (
    !Helper.length ||
    !draft.columns.length ||
    draft.data.some((row) => !String(row.size ?? "").trim())
  ) {
    throw new Error("لطفاً جدول راهنمای سایز را تکمیل کنید");
  }
  return { ...(draft.helperId ? { id: draft.helperId } : {}), Helper };
}
function helperDraft(
  helper?: { id: number; attributes: { Helper?: unknown } } | null,
): SizeGuideDraft {
  const { rows, columns } = normalizeSizeGuideData(
    (helper?.attributes?.Helper || []) as Parameters<
      typeof normalizeSizeGuideData
    >[0],
  );
  return {
    data: rows,
    columns,
    helperId: helper?.id,
    saved: JSON.stringify(serializeSizeGuideMatrix(rows, columns)),
    editing: false,
  };
}

const Sizes = forwardRef<SizeGuideHandle, { productId: number }>(
  ({ productId }, ref) => {
    const { session, canEdit, client } = useProductEditor();
    const restored = session?.drafts.get("size-guide") as
      | SizeGuideDraft
      | undefined;
    const helper =
      session?.snapshot?.product.attributes.product_size_helper?.data;
    const [draft, setDraft] = useState<SizeGuideDraft>(
      () => restored ?? helperDraft(helper),
    );
    const [loading, setLoading] = useState(!session && !restored);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
      session?.drafts.set("size-guide", draft);
    }, [session, draft]);

    useEffect(() => {
      if (session) return;
      let cancelled = false;
      getProductSizeHelper(productId)
        .then((response) => {
          if (!cancelled) setDraft(helperDraft(response.data?.[0]));
        })
        .catch(() => toast.error("خطا در بارگذاری راهنمای سایز"))
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    }, [productId, session]);

    const startEditing = () => {
      if (!canEdit) return;
      setDraft((current) => ({
        ...current,
        editing: true,
        ...(current.data.length === 0 && current.columns.length === 0
          ? {
              data: [{ size: "" }],
              columns: [
                { key: "metric-1", title: "" },
                { key: "metric-2", title: "" },
              ],
            }
          : {}),
      }));
    };
    const handleSave = useCallback(
      async (data: any[]) => {
        if (!canEdit || saving) return false;
        const next = { ...draft, data };
        setDraft(next);
        try {
          const payload = sizeGuideDraftPayload(next);
          if (!payload) {
            setDraft({ ...next, editing: false });
            return true;
          }
          setSaving(true);
          const response = draft.helperId
            ? await client.put<{ id: number }>(
                `/product-size-helpers/${draft.helperId}`,
                { data: { product: productId, Helper: payload.Helper } },
                { retries: 0 },
              )
            : await client.post<{ id: number }>(
                "/product-size-helpers",
                { data: { product: productId, Helper: payload.Helper } },
                { retries: 0 },
              );
          setDraft({
            ...next,
            helperId: response.data.id,
            saved: JSON.stringify(payload.Helper),
            editing: false,
          });
          toast.success("راهنمای سایز ذخیره شد");
          return true;
        } catch {
          toast.error("راهنمای سایز ذخیره نشد");
          return false;
        } finally {
          setSaving(false);
        }
      },
      [canEdit, client, draft, productId, saving],
    );

    useImperativeHandle(
      ref,
      () => ({
        getPayload: () => sizeGuideDraftPayload(draft),
        save: () => handleSave(draft.data),
        acceptSaved: (helper) => setDraft(helperDraft(helper)),
      }),
      [draft, handleSave],
    );
    if (loading) return <div>در حال بارگذاری راهنمای سایز...</div>;
    return (
      <fieldset
        disabled={!canEdit || saving}
        inert={!canEdit ? true : undefined}
        className="flex flex-col gap-4"
      >
        {draft.editing ? (
          <SizeGuideEditor
            onSave={handleSave}
            initialData={draft.data}
            columns={draft.columns}
            onColumnTitleEdit={(columnKey, title) =>
              setDraft((current) => ({
                ...current,
                columns: title
                  ? current.columns.map((column) =>
                      column.key === columnKey ? { ...column, title } : column,
                    )
                  : current.columns.filter(
                      (column) => column.key !== columnKey,
                    ),
              }))
            }
            onDataChange={(data, columns) =>
              setDraft((current) => ({ ...current, data, columns }))
            }
          />
        ) : draft.data.length ? (
          <div className="relative">
            <button
              onClick={startEditing}
              className="absolute right-4 top-4 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white"
            >
              ویرایش راهنما
            </button>
            <SizeTable
              data={draft.data}
              columns={draft.columns}
              title="راهنمای سایز"
            />
          </div>
        ) : (
          <div className="py-8 text-center">
            <p className="mb-4 text-neutral-600">راهنمای سایز موجود نیست</p>
            <button
              onClick={startEditing}
              className="rounded-lg bg-blue-600 px-6 py-2.5 text-sm text-white"
            >
              ایجاد راهنمای سایز
            </button>
          </div>
        )}
      </fieldset>
    );
  },
);
Sizes.displayName = "Sizes";
export default Sizes;
