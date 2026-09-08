"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Check,
  FileText,
  Loader2,
  RefreshCw,
  Search,
} from "lucide-react";
import toast from "react-hot-toast";
import type { ApiError } from "@repo/api/types";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import RichTextEditor from "@/components/RichTextEditor";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  categoryEditorialErrorMessage,
  getCategoryEditorial,
  listCategoryEditorialTargets,
  saveCategoryEditorial,
  type CategoryEditorialDraft,
  type CategoryEditorialTarget,
  type EditableCategoryEditorial,
} from "@/services/categoryEditorial";

const EMPTY_DRAFT: CategoryEditorialDraft = {
  title: "",
  paragraph: "",
  content: "",
  isPublished: false,
  isRtl: true,
};

const STATUS_LABEL = {
  active: "منتشرشده",
  draft: "پیش‌نویس",
  none: "بدون محتوا",
} as const;
const STATUS_STYLE = {
  active: "bg-emerald-50 text-emerald-700",
  draft: "bg-amber-50 text-amber-700",
  none: "bg-neutral-100 text-neutral-500",
} as const;

function draftFromRecord(
  record: EditableCategoryEditorial,
): CategoryEditorialDraft {
  if (!record.editorial) return EMPTY_DRAFT;
  return {
    title: record.editorial.title,
    paragraph: record.editorial.paragraph,
    content: record.editorial.content,
    isPublished: record.editorial.isPublished,
    isRtl: record.editorial.isRtl,
  };
}

export default function CategoryEditorialPage() {
  const [targets, setTargets] = useState<CategoryEditorialTarget[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const [targetCount, setTargetCount] = useState(0);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [record, setRecord] = useState<EditableCategoryEditorial | null>(null);
  const [draft, setDraft] = useState<CategoryEditorialDraft>(EMPTY_DRAFT);
  const [initialDraft, setInitialDraft] =
    useState<CategoryEditorialDraft>(EMPTY_DRAFT);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);

  const isDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(initialDraft),
    [draft, initialDraft],
  );

  const loadTargets = useCallback(async (q = "", nextPage = 1) => {
    setLoadingTargets(true);
    try {
      const response = await listCategoryEditorialTargets({
        q,
        page: nextPage,
      });
      setTargets(response.data);
      setPageCount(Math.max(response.meta?.pagination?.pageCount ?? 1, 1));
      setTargetCount(response.meta?.pagination?.total ?? response.data.length);
      setError(null);
    } catch (requestError) {
      setError(categoryEditorialErrorMessage(requestError));
    } finally {
      setLoadingTargets(false);
    }
  }, []);

  const loadRecord = useCallback(async (categoryId: number) => {
    setLoadingRecord(true);
    setConflict(false);
    try {
      const next = await getCategoryEditorial(categoryId);
      const nextDraft = draftFromRecord(next);
      setRecord(next);
      setDraft(nextDraft);
      setInitialDraft(nextDraft);
      setError(null);
    } catch (requestError) {
      setError(categoryEditorialErrorMessage(requestError));
    } finally {
      setLoadingRecord(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTargets(query, page), 250);
    return () => window.clearTimeout(timer);
  }, [loadTargets, page, query]);

  useEffect(() => {
    const protectUnsaved = (event: BeforeUnloadEvent) => {
      if (!isDirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protectUnsaved);
    return () => window.removeEventListener("beforeunload", protectUnsaved);
  }, [isDirty]);

  const selectTarget = (categoryId: number) => {
    if (categoryId === selectedId) return;
    if (isDirty && !window.confirm("تغییرات ذخیره‌نشده کنار گذاشته شود؟"))
      return;
    setSelectedId(categoryId);
    void loadRecord(categoryId);
  };

  const updateDraft = <K extends keyof CategoryEditorialDraft>(
    field: K,
    value: CategoryEditorialDraft[K],
  ) => setDraft((current) => ({ ...current, [field]: value }));

  const save = async () => {
    if (!selectedId || !record) return;
    if (!draft.title.trim()) {
      toast.error("عنوان محتوا را وارد کنید");
      return;
    }
    if (
      draft.isPublished &&
      !draft.paragraph.trim() &&
      !draft.content.replace(/<[^>]*>/g, "").trim()
    ) {
      toast.error("برای انتشار، مقدمه یا متن اصلی را وارد کنید");
      return;
    }
    setSaving(true);
    setConflict(false);
    try {
      const response = await saveCategoryEditorial(
        selectedId,
        draft,
        record.editorial?.updatedAt ?? null,
      );
      const nextDraft = draftFromRecord(response.data);
      setRecord(response.data);
      setDraft(nextDraft);
      setInitialDraft(nextDraft);
      await loadTargets(query, page);
      if (response.meta?.revalidationFailed) {
        toast.error("محتوا ذخیره شد؛ تازه‌سازی فروشگاه انجام نشد.");
      } else {
        toast.success("محتوا ذخیره شد");
      }
    } catch (requestError: unknown) {
      setConflict((requestError as ApiError)?.status === 409);
      setError(categoryEditorialErrorMessage(requestError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ContentWrapper title="محتوای دسته‌های فروشگاه">
      <div
        dir="rtl"
        className="mt-6 grid min-h-[640px] gap-5 lg:grid-cols-[320px_minmax(0,1fr)]"
      >
        <aside className="rounded-2xl border border-neutral-200 bg-white p-4">
          <label
            htmlFor="category-editorial-search"
            className="mb-2 block text-sm font-medium text-neutral-700"
          >
            جست‌وجوی دسته
          </label>
          <Input
            id="category-editorial-search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="نام یا نشانی دسته"
            rightElement={<Search className="h-4 w-4 text-neutral-400" />}
          />
          <div className="mt-4 space-y-2" aria-live="polite">
            {loadingTargets ? (
              <p className="flex items-center gap-2 py-8 text-sm text-neutral-500">
                <Loader2 className="h-4 w-4 animate-spin" /> در حال دریافت…
              </p>
            ) : targets.length === 0 ? (
              <p className="py-8 text-center text-sm text-neutral-500">
                دسته‌ای پیدا نشد.
              </p>
            ) : (
              targets.map((target) => (
                <button
                  key={target.id}
                  type="button"
                  onClick={() => selectTarget(target.id)}
                  className={`w-full rounded-xl border p-3 text-right transition ${selectedId === target.id ? "border-infinity-primary bg-infinity-primary-lighter/20" : "border-neutral-200 hover:border-neutral-300"}`}
                >
                  <span className="block truncate text-sm font-medium text-neutral-900">
                    {target.title}
                  </span>
                  <span className="mt-2 flex items-center justify-between gap-2 text-xs">
                    <span
                      className={`rounded-full px-2 py-1 ${STATUS_STYLE[target.status]}`}
                    >
                      {STATUS_LABEL[target.status]}
                    </span>
                    <span className="text-neutral-400">
                      {target.updatedAt
                        ? new Date(target.updatedAt).toLocaleDateString("fa-IR")
                        : "—"}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
          {!loadingTargets && targetCount > 0 ? (
            <nav
              aria-label="صفحه‌بندی دسته‌ها"
              className="mt-4 flex items-center justify-between gap-2 border-t border-neutral-100 pt-4 text-xs text-neutral-500"
            >
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((current) => Math.max(current - 1, 1))}
                className="rounded-lg border border-neutral-200 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                قبلی
              </button>
              <span>
                صفحه {page.toLocaleString("fa-IR")} از{" "}
                {pageCount.toLocaleString("fa-IR")}
              </span>
              <button
                type="button"
                disabled={page >= pageCount}
                onClick={() =>
                  setPage((current) => Math.min(current + 1, pageCount))
                }
                className="rounded-lg border border-neutral-200 px-3 py-1.5 disabled:cursor-not-allowed disabled:opacity-40"
              >
                بعدی
              </button>
            </nav>
          ) : null}
        </aside>

        <section className="rounded-2xl border border-neutral-200 bg-white p-4 sm:p-6">
          {!selectedId ? (
            <div className="flex min-h-[500px] flex-col items-center justify-center text-center text-neutral-500">
              <FileText className="mb-3 h-10 w-10" />
              <p>برای ویرایش، یک دسته را انتخاب کنید.</p>
            </div>
          ) : loadingRecord ? (
            <div className="flex min-h-[500px] items-center justify-center gap-2 text-neutral-500">
              <Loader2 className="h-5 w-5 animate-spin" /> در حال دریافت محتوا…
            </div>
          ) : record ? (
            <div className="space-y-5">
              <header className="flex flex-col gap-3 border-b border-neutral-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h1 className="text-xl font-semibold text-neutral-900">
                    {record.category.title}
                  </h1>
                  <p
                    dir="ltr"
                    className="mt-1 text-left text-xs text-neutral-400"
                  >
                    /plp/category/{record.category.slug}
                  </p>
                </div>
                <Button
                  onClick={() => void save()}
                  disabled={saving || !isDirty}
                >
                  {saving ? (
                    <Loader2 className="ml-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Check className="ml-2 h-4 w-4" />
                  )}
                  ذخیره
                </Button>
              </header>

              {error && (
                <div
                  role="alert"
                  className="flex items-center justify-between gap-3 rounded-xl bg-red-50 p-3 text-sm text-red-700"
                >
                  <span className="flex items-center gap-2">
                    <AlertTriangle className="h-4 w-4" />
                    {error}
                  </span>
                  {conflict && (
                    <button
                      type="button"
                      onClick={() => void loadRecord(record.category.id)}
                      className="flex items-center gap-1 underline"
                    >
                      <RefreshCw className="h-4 w-4" /> دریافت نسخه تازه
                    </button>
                  )}
                </div>
              )}

              <div>
                <label
                  htmlFor="editorial-title"
                  className="mb-2 block text-sm font-medium text-neutral-700"
                >
                  عنوان بخش
                </label>
                <Input
                  id="editorial-title"
                  value={draft.title}
                  onChange={(event) => updateDraft("title", event.target.value)}
                  placeholder="عنوانی که در فروشگاه نمایش داده می‌شود"
                />
              </div>
              <div>
                <label
                  htmlFor="editorial-intro"
                  className="mb-2 block text-sm font-medium text-neutral-700"
                >
                  مقدمه
                </label>
                <textarea
                  id="editorial-intro"
                  value={draft.paragraph}
                  onChange={(event) =>
                    updateDraft("paragraph", event.target.value)
                  }
                  rows={3}
                  className="input w-full resize-y p-3"
                  placeholder="متن کوتاه آغاز بخش"
                />
              </div>
              <div>
                <span className="mb-2 block text-sm font-medium text-neutral-700">
                  متن اصلی
                </span>
                <RichTextEditor
                  preset="category-editorial"
                  content={draft.content}
                  onChange={(value) => updateDraft("content", value)}
                  placeholder="متن تکمیلی دسته را بنویسید…"
                />
              </div>
              <div className="flex flex-wrap gap-5 rounded-xl bg-neutral-50 p-4 text-sm">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.isPublished}
                    onChange={(event) =>
                      updateDraft("isPublished", event.target.checked)
                    }
                  />{" "}
                  نمایش در فروشگاه
                </label>
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.isRtl}
                    onChange={(event) =>
                      updateDraft("isRtl", event.target.checked)
                    }
                  />{" "}
                  راست‌به‌چپ
                </label>
                {isDirty && (
                  <span className="text-amber-700">
                    تغییرات ذخیره نشده است.
                  </span>
                )}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </ContentWrapper>
  );
}
