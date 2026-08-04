"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import toast from "react-hot-toast";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import ConfirmDialog from "@/components/Kits/ConfirmDialog";
import { apiClient } from "@/services";
import { ENDPOINTS } from "@/constants/api";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { extractErrorMessage, translateErrorMessage } from "@/lib/errorTranslations";

type ProductTag = {
  id: number;
  Title: string;
};

const normalizeTag = (entry: any): ProductTag => ({
  id: Number(entry.id),
  Title: String(entry.attributes?.Title ?? entry.Title ?? ""),
});

export default function TagsPage() {
  const router = useRouter();
  const { roleName } = useCurrentUser();
  const isSuperadmin = (roleName || "").toLowerCase().trim() === "superadmin";
  const [tags, setTags] = useState<ProductTag[]>([]);
  const [search, setSearch] = useState("");
  const [title, setTitle] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if ((roleName || "").toLowerCase().trim() === "editor") {
      router.replace("/blog");
    }
  }, [roleName, router]);

  const loadTags = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiClient.get<any>(
        `${ENDPOINTS.PRODUCT.TAG}?pagination[pageSize]=500&sort=Title:asc`,
        { cache: "no-store" },
      );
      setTags(((response as any)?.data || []).map(normalizeTag));
    } catch (error) {
      toast.error("خطا در دریافت برچسب‌ها");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadTags();
  }, [loadTags]);

  const filteredTags = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fa");
    return query ? tags.filter((tag) => tag.Title.toLocaleLowerCase("fa").includes(query)) : tags;
  }, [search, tags]);

  const resetForm = () => {
    setEditingId(null);
    setTitle("");
  };

  const saveTag = async () => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      toast.error("نام برچسب الزامی است");
      return;
    }

    setSaving(true);
    try {
      if (editingId) {
        await apiClient.put(`${ENDPOINTS.PRODUCT.TAG}/${editingId}`, {
          data: { Title: normalizedTitle },
        });
        toast.success("برچسب به‌روزرسانی شد");
      } else {
        await apiClient.post(ENDPOINTS.PRODUCT.TAG, {
          data: { Title: normalizedTitle },
        });
        toast.success("برچسب ایجاد شد");
      }
      resetForm();
      await loadTags();
    } catch (error) {
      toast.error(translateErrorMessage(extractErrorMessage(error), "خطا در ذخیره برچسب"));
    } finally {
      setSaving(false);
    }
  };

  const deleteTag = async () => {
    if (!deleteId || !isSuperadmin) return;
    setSaving(true);
    try {
      await apiClient.delete(`${ENDPOINTS.PRODUCT.TAG}/${deleteId}`);
      setDeleteId(null);
      toast.success("برچسب حذف شد");
      await loadTags();
    } catch (error) {
      toast.error(translateErrorMessage(extractErrorMessage(error), "خطا در حذف برچسب"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ContentWrapper title="مدیریت برچسب‌های محصول">
      <div className="space-y-5" dir="rtl">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-semibold text-slate-800">
              {editingId ? "ویرایش برچسب" : "افزودن برچسب"}
            </h2>
            {editingId && (
              <button type="button" className="text-sm text-slate-500" onClick={resetForm}>
                انصراف
              </button>
            )}
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              className="flex-1 rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-infinity-primary"
              placeholder="نام برچسب"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void saveTag();
              }}
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void saveTag()}
              className="rounded-xl bg-infinity-primary px-5 py-2 text-white disabled:opacity-50"
            >
              {editingId ? "ذخیره تغییرات" : "ثبت برچسب"}
            </button>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <input
              className="rounded-xl border border-slate-200 px-3 py-2 outline-none focus:border-infinity-primary"
              placeholder="جستجوی برچسب"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <span className="text-sm text-slate-500">{filteredTags.length} برچسب</span>
          </div>

          {loading ? (
            <div className="py-10 text-center text-sm text-slate-500">در حال دریافت...</div>
          ) : filteredTags.length === 0 ? (
            <div className="py-10 text-center text-sm text-slate-500">برچسبی یافت نشد.</div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredTags.map((tag) => (
                <article
                  key={tag.id}
                  className="flex items-center justify-between gap-3 rounded-xl border border-slate-100 p-3"
                >
                  <span className="font-medium text-slate-800">{tag.Title}</span>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm"
                      onClick={() => {
                        setEditingId(tag.id);
                        setTitle(tag.Title);
                      }}
                    >
                      ویرایش
                    </button>
                    {isSuperadmin && (
                      <button
                        type="button"
                        className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-sm text-red-700"
                        onClick={() => setDeleteId(tag.id)}
                      >
                        حذف
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <ConfirmDialog
        isOpen={deleteId !== null}
        title="حذف دائمی برچسب"
        description="این عملیات قابل بازگشت نیست. ادامه می‌دهید؟"
        confirmText="بله، حذف کن"
        cancelText="انصراف"
        onConfirm={() => void deleteTag()}
        onCancel={() => setDeleteId(null)}
      />
    </ContentWrapper>
  );
}
