"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import { apiClient } from "@/services";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";

type AttributeTerm = {
  id: number;
  Title: string;
  Slug: string;
  ColorCode: string | null;
  Position: number;
};

type ProductAttribute = {
  id: number;
  Title: string;
  Slug: string;
  Scope: "Global" | "Product";
  Type: "Text" | "Color";
  LegacyProjection: "None" | "Color" | "Size" | "Model";
  Position: number;
  terms: AttributeTerm[];
};

type AttributeForm = Omit<ProductAttribute, "id" | "terms">;
type TermForm = Omit<AttributeTerm, "id" | "ColorCode"> & { ColorCode: string };

const unwrap = (entry: any) => ({ id: Number(entry.id), ...(entry.attributes || entry) });

const normalizeAttribute = (entry: any): ProductAttribute => {
  const value = unwrap(entry);
  const rawTerms = value.product_attribute_terms?.data || value.product_attribute_terms || [];
  return {
    id: value.id,
    Title: value.Title || "",
    Slug: value.Slug || "",
    Scope: value.Scope || "Global",
    Type: value.Type || "Text",
    LegacyProjection: value.LegacyProjection || "None",
    Position: Number(value.Position || 0),
    terms: rawTerms.map(unwrap),
  };
};

const emptyAttribute: AttributeForm = {
  Title: "",
  Slug: "",
  Scope: "Global",
  Type: "Text",
  LegacyProjection: "None",
  Position: 0,
};

const emptyTerm: TermForm = { Title: "", Slug: "", ColorCode: "", Position: 0 };

export default function AttributesPage() {
  const router = useRouter();
  const { roleName } = useCurrentUser();
  const [attributes, setAttributes] = useState<ProductAttribute[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [attributeForm, setAttributeForm] = useState<AttributeForm>({ ...emptyAttribute });
  const [editingAttributeId, setEditingAttributeId] = useState<number | null>(null);
  const [termParentId, setTermParentId] = useState<number | null>(null);
  const [editingTermId, setEditingTermId] = useState<number | null>(null);
  const [termForm, setTermForm] = useState<TermForm>({ ...emptyTerm });

  useEffect(() => {
    if ((roleName || "").toLowerCase().trim() === "editor") {
      router.replace("/blog");
    }
  }, [roleName, router]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<any>(
        "/product-attributes?populate[product_attribute_terms]=*&pagination[pageSize]=200&sort=Position:asc",
        { cache: "no-store" },
      );
      setAttributes(((response as any)?.data || []).map(normalizeAttribute));
    } catch (error) {
      toast.error("خطا در دریافت ویژگی‌ها");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const orderedAttributes = useMemo(
    () => [...attributes].sort((a, b) => a.Position - b.Position || a.Title.localeCompare(b.Title)),
    [attributes],
  );

  const saveAttribute = async () => {
    if (!attributeForm.Title.trim() || !attributeForm.Slug.trim()) {
      toast.error("نام و نامک ویژگی الزامی است");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...attributeForm,
        Title: attributeForm.Title.trim(),
        Slug: attributeForm.Slug.trim(),
        Position: Number(attributeForm.Position || 0),
      };
      if (editingAttributeId) {
        await apiClient.put(`/product-attributes/${editingAttributeId}`, { data: payload });
      } else {
        await apiClient.post("/product-attributes", { data: payload });
      }
      toast.success(editingAttributeId ? "ویژگی به‌روزرسانی شد" : "ویژگی ایجاد شد");
      setEditingAttributeId(null);
      setAttributeForm({ ...emptyAttribute });
      await load();
    } catch (error) {
      toast.error(translateErrorMessage(extractErrorMessage(error), "خطا در ذخیره ویژگی"));
    } finally {
      setSaving(false);
    }
  };

  const saveTerm = async () => {
    if (!termParentId || !termForm.Title.trim()) {
      toast.error("نام مقدار ویژگی الزامی است");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        Title: termForm.Title.trim(),
        Slug: termForm.Slug.trim() || null,
        ColorCode: termForm.ColorCode.trim() || null,
        Position: Number(termForm.Position || 0),
        ...(editingTermId ? {} : { product_attribute: termParentId }),
      };
      if (editingTermId) {
        await apiClient.put(`/product-attribute-terms/${editingTermId}`, { data: payload });
      } else {
        await apiClient.post("/product-attribute-terms", { data: payload });
      }
      toast.success(editingTermId ? "مقدار به‌روزرسانی شد" : "مقدار ایجاد شد");
      setTermParentId(null);
      setEditingTermId(null);
      setTermForm({ ...emptyTerm });
      await load();
    } catch (error) {
      toast.error(translateErrorMessage(extractErrorMessage(error), "خطا در ذخیره مقدار"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ContentWrapper title="ویژگی‌های تنوع محصول">
      <div className="space-y-5" dir="rtl">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="font-semibold text-slate-800">
              {editingAttributeId ? "ویرایش ویژگی" : "افزودن ویژگی"}
            </h2>
            {editingAttributeId && (
              <button
                type="button"
                className="text-sm text-slate-500"
                onClick={() => {
                  setEditingAttributeId(null);
                  setAttributeForm({ ...emptyAttribute });
                }}
              >
                انصراف
              </button>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <input
              className="rounded-xl border p-2"
              placeholder="نام ویژگی"
              value={attributeForm.Title}
              onChange={(event) =>
                setAttributeForm((value) => ({ ...value, Title: event.target.value }))
              }
            />
            <input
              className="rounded-xl border p-2"
              placeholder="نامک"
              dir="ltr"
              value={attributeForm.Slug}
              onChange={(event) =>
                setAttributeForm((value) => ({ ...value, Slug: event.target.value }))
              }
            />
            <input
              className="rounded-xl border p-2"
              type="number"
              min={0}
              placeholder="ترتیب"
              value={attributeForm.Position}
              onChange={(event) =>
                setAttributeForm((value) => ({ ...value, Position: Number(event.target.value) }))
              }
            />
            <select
              className="rounded-xl border p-2"
              value={attributeForm.Scope}
              onChange={(event) =>
                setAttributeForm((value) => ({
                  ...value,
                  Scope: event.target.value as "Global" | "Product",
                }))
              }
            >
              <option value="Global">سراسری</option>
              <option value="Product">مختص محصول</option>
            </select>
            <select
              className="rounded-xl border p-2"
              value={attributeForm.Type}
              onChange={(event) =>
                setAttributeForm((value) => ({
                  ...value,
                  Type: event.target.value as "Text" | "Color",
                }))
              }
            >
              <option value="Text">متنی</option>
              <option value="Color">رنگ</option>
            </select>
            <button
              type="button"
              disabled={saving}
              onClick={saveAttribute}
              className="rounded-xl bg-infinity-primary px-4 py-2 text-white disabled:opacity-50"
            >
              ذخیره ویژگی
            </button>
          </div>
        </section>

        {loading ? (
          <div className="py-10 text-center text-slate-500">در حال دریافت ویژگی‌ها...</div>
        ) : (
          orderedAttributes.map((attribute) => (
            <section
              key={attribute.id}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold text-slate-900">{attribute.Title}</h3>
                  <p className="text-xs text-slate-500" dir="ltr">
                    {attribute.Slug}
                  </p>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="rounded-lg border px-3 py-1.5 text-sm"
                    onClick={() => {
                      setEditingAttributeId(attribute.id);
                      setAttributeForm({
                        Title: attribute.Title,
                        Slug: attribute.Slug,
                        Scope: attribute.Scope,
                        Type: attribute.Type,
                        LegacyProjection: attribute.LegacyProjection,
                        Position: attribute.Position,
                      });
                    }}
                  >
                    ویرایش ویژگی
                  </button>
                  <button
                    type="button"
                    className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm"
                    onClick={() => {
                      setTermParentId(attribute.id);
                      setEditingTermId(null);
                      setTermForm({ ...emptyTerm });
                    }}
                  >
                    افزودن مقدار
                  </button>
                </div>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {attribute.terms.length === 0 && (
                  <span className="text-sm text-slate-400">هنوز مقداری ثبت نشده است.</span>
                )}
                {attribute.terms.map((term) => (
                  <button
                    key={term.id}
                    type="button"
                    onClick={() => {
                      setTermParentId(attribute.id);
                      setEditingTermId(term.id);
                      setTermForm({
                        Title: term.Title,
                        Slug: term.Slug || "",
                        ColorCode: term.ColorCode || "",
                        Position: term.Position,
                      });
                    }}
                    className="rounded-full border border-slate-200 px-3 py-1.5 text-sm hover:border-infinity-primary"
                  >
                    {term.ColorCode && (
                      <span
                        className="ml-1 inline-block h-3 w-3 rounded-full border align-middle"
                        style={{ backgroundColor: term.ColorCode }}
                      />
                    )}
                    {term.Title}
                  </button>
                ))}
              </div>

              {termParentId === attribute.id && (
                <div className="mt-4 grid gap-2 rounded-xl bg-slate-50 p-3 md:grid-cols-5">
                  <input
                    className="rounded-lg border p-2"
                    placeholder="نام مقدار"
                    value={termForm.Title}
                    onChange={(event) =>
                      setTermForm((value) => ({ ...value, Title: event.target.value }))
                    }
                  />
                  <input
                    className="rounded-lg border p-2"
                    placeholder="نامک"
                    dir="ltr"
                    value={termForm.Slug}
                    onChange={(event) =>
                      setTermForm((value) => ({ ...value, Slug: event.target.value }))
                    }
                  />
                  <input
                    className="rounded-lg border p-2"
                    placeholder="#RRGGBB (اختیاری)"
                    dir="ltr"
                    value={termForm.ColorCode}
                    onChange={(event) =>
                      setTermForm((value) => ({ ...value, ColorCode: event.target.value }))
                    }
                  />
                  <input
                    className="rounded-lg border p-2"
                    type="number"
                    min={0}
                    placeholder="ترتیب"
                    value={termForm.Position}
                    onChange={(event) =>
                      setTermForm((value) => ({ ...value, Position: Number(event.target.value) }))
                    }
                  />
                  <button
                    type="button"
                    disabled={saving}
                    onClick={saveTerm}
                    className="rounded-lg bg-infinity-primary px-3 py-2 text-white disabled:opacity-50"
                  >
                    ذخیره مقدار
                  </button>
                </div>
              )}
            </section>
          ))
        )}
      </div>
    </ContentWrapper>
  );
}
