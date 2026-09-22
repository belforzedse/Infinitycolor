"use client";

import React, { useMemo, useRef, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  GripVertical,
  ImagePlus,
  Plus,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import type { CreateStoryData, StoryItemInput, StoryMediaType, StoryOverlay } from "@/types/story";
import { uploadFile } from "@/services/super-admin/files/upload";
import resolveAssetUrl from "@/utils/resolveAssetUrl";

const MAX_ITEMS = 20;

export type StoryFormItemValues = {
  localId: string;
  id?: number;
  Key?: string;
  MediaType: StoryMediaType;
  mediaId?: number;
  mediaUrl?: string;
  thumbnailId?: number;
  thumbnailUrl?: string;
  DurationMs: number;
  CtaUrl?: string | null;
  Overlays?: StoryOverlay[];
};

export interface StoryFormValues {
  Title: string;
  IsActive: boolean;
  SortOrder: number;
  StartAt?: string | null;
  EndAt?: string | null;
  updatedAt?: string;
  coverId?: number;
  coverUrl?: string;
  Items: StoryFormItemValues[];
}

interface StoryFormProps {
  initialValues?: Partial<StoryFormValues>;
  onSubmit: (data: CreateStoryData) => Promise<void>;
  isLoading: boolean;
  submitLabel: string;
}

function clientKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `item-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function blankItem(): StoryFormItemValues {
  return { localId: clientKey(), MediaType: "image", DurationMs: 5000, Overlays: [] };
}

function blankOverlay(): StoryOverlay {
  return { id: clientKey(), type: "text", x: 50, y: 50, content: "", fontSize: 28, fontColor: "#ffffff" };
}

function OverlayEditor({ overlays, onChange }: { overlays: StoryOverlay[]; onChange: (overlays: StoryOverlay[]) => void }) {
  const update = (id: string, patch: Partial<StoryOverlay>) =>
    onChange(overlays.map((overlay) => overlay.id === id ? { ...overlay, ...patch } : overlay));
  return (
    <div className="mt-5 border-t border-slate-100 pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">لایه‌های روی آیتم</span>
        <button type="button" disabled={overlays.length >= 12} onClick={() => onChange([...overlays, blankOverlay()])} className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 disabled:opacity-40">افزودن لایه</button>
      </div>
      <div className="space-y-3">
        {overlays.map((overlay, overlayIndex) => (
          <div key={overlay.id} className="rounded-xl bg-slate-50 p-3">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">لایه {overlayIndex + 1}</span>
              <button type="button" onClick={() => onChange(overlays.filter((entry) => entry.id !== overlay.id))} className="rounded-md p-1.5 text-rose-500 hover:bg-rose-50" aria-label={`حذف لایه ${overlayIndex + 1}`}><Trash2 className="h-4 w-4" aria-hidden /></button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <label className="text-xs text-slate-600">نوع<select value={overlay.type} onChange={(event) => update(overlay.id, { type: event.target.value as StoryOverlay["type"] })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2"><option value="text">متن</option><option value="sticker">تصویر</option><option value="shape">شکل</option></select></label>
              <label className="text-xs text-slate-600">افقی (%)<input type="number" min={0} max={100} value={overlay.x} onChange={(event) => update(overlay.id, { x: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
              <label className="text-xs text-slate-600">عمودی (%)<input type="number" min={0} max={100} value={overlay.y} onChange={(event) => update(overlay.id, { y: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
              <label className="text-xs text-slate-600">چرخش<input type="number" min={-360} max={360} value={overlay.rotation ?? 0} onChange={(event) => update(overlay.id, { rotation: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
              {overlay.type === "text" ? <>
                <label className="text-xs text-slate-600 sm:col-span-2">متن<input value={overlay.content ?? ""} maxLength={300} onChange={(event) => update(overlay.id, { content: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
                <label className="text-xs text-slate-600">اندازه متن<input type="number" min={8} max={96} value={overlay.fontSize ?? 28} onChange={(event) => update(overlay.id, { fontSize: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
              </> : null}
              {overlay.type === "sticker" ? <label className="text-xs text-slate-600 sm:col-span-2">نشانی تصویر<input dir="ltr" inputMode="url" value={overlay.imageUrl ?? ""} onChange={(event) => update(overlay.id, { imageUrl: event.target.value })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2 text-left" /></label> : null}
              {overlay.type !== "text" ? <>
                <label className="text-xs text-slate-600">عرض (%)<input type="number" min={1} max={100} value={overlay.width ?? 20} onChange={(event) => update(overlay.id, { width: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
                <label className="text-xs text-slate-600">ارتفاع (%)<input type="number" min={1} max={100} value={overlay.height ?? 20} onChange={(event) => update(overlay.id, { height: Number(event.target.value) })} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-2" /></label>
              </> : null}
              {overlay.type !== "sticker" ? <label className="text-xs text-slate-600">رنگ<input type="color" value={overlay.fontColor ?? "#ffffff"} onChange={(event) => update(overlay.id, { fontColor: event.target.value })} className="mt-1 h-9 w-full rounded-lg border border-slate-200 bg-white p-1" /></label> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function fullUrl(url?: string, version?: string) {
  if (!url) return undefined;
  const value = resolveAssetUrl(url) || url.trim().replace(/\s+/g, "");
  if (!version) return value;
  return `${value}${value.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

function toDateInput(value?: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

function SortableItemCard({
  item,
  index,
  count,
  version,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  onUploadState,
}: {
  item: StoryFormItemValues;
  index: number;
  count: number;
  version?: string;
  onChange: (patch: Partial<StoryFormItemValues>) => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onUploadState: (uploading: boolean) => void;
}) {
  const mediaInput = useRef<HTMLInputElement>(null);
  const posterInput = useRef<HTMLInputElement>(null);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [uploadingPoster, setUploadingPoster] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.localId,
  });

  async function upload(file: File, kind: "media" | "poster") {
    const setLocal = kind === "media" ? setUploadingMedia : setUploadingPoster;
    setLocal(true);
    onUploadState(true);
    try {
      const uploaded = (await uploadFile(file))?.[0];
      if (!uploaded) throw new Error("upload failed");
      if (kind === "media") {
        onChange({
          mediaId: uploaded.id,
          mediaUrl: uploaded.url,
          MediaType: file.type.startsWith("video/") ? "video" : "image",
        });
      } else {
        onChange({ thumbnailId: uploaded.id, thumbnailUrl: uploaded.url });
      }
    } catch {
      toast.error(kind === "media" ? "آپلود رسانه ناموفق بود." : "آپلود پیش‌نمایش ناموفق بود.");
    } finally {
      setLocal(false);
      onUploadState(false);
    }
  }

  return (
    <article
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${isDragging ? "z-20 opacity-70" : ""}`}
      aria-label={`آیتم ${index + 1}`}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="touch-none rounded-lg p-2 text-slate-400 hover:bg-slate-100"
            aria-label={`جابجایی آیتم ${index + 1}`}
            {...attributes}
            {...listeners}
          >
            <GripVertical className="h-5 w-5" aria-hidden />
          </button>
          <h2 className="font-peyda text-sm font-semibold text-slate-800">آیتم {index + 1}</h2>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
            {item.MediaType === "video" ? "ویدیو" : "تصویر"}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={() => onMove(-1)} disabled={index === 0} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="انتقال به بالا">
            <ArrowUp className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" onClick={() => onMove(1)} disabled={index === count - 1} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="انتقال به پایین">
            <ArrowDown className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" onClick={onDuplicate} disabled={count >= MAX_ITEMS} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-30" aria-label="کپی آیتم">
            <Copy className="h-4 w-4" aria-hidden />
          </button>
          <button type="button" onClick={onRemove} disabled={count === 1} className="rounded-lg p-2 text-rose-500 hover:bg-rose-50 disabled:opacity-30" aria-label="حذف آیتم">
            <Trash2 className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <span className="mb-2 block text-sm font-medium text-slate-700">رسانه</span>
          {item.mediaUrl ? (
            <div className="relative inline-flex">
              {item.MediaType === "video" ? (
                <video src={fullUrl(item.mediaUrl, version)} controls className="h-52 max-w-full rounded-xl bg-black" />
              ) : (
                <img src={fullUrl(item.mediaUrl, version)} alt="" className="h-52 max-w-full rounded-xl object-cover" />
              )}
              <button type="button" onClick={() => onChange({ mediaId: undefined, mediaUrl: undefined })} className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-1 text-white" aria-label="حذف رسانه">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <button type="button" disabled={uploadingMedia} onClick={() => mediaInput.current?.click()} className="flex min-h-40 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-400 hover:border-infinity-primary-light">
              <Upload className="h-7 w-7" aria-hidden />
              {uploadingMedia ? "در حال آپلود..." : "آپلود تصویر یا ویدیو"}
            </button>
          )}
          <input ref={mediaInput} type="file" accept="image/*,video/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, "media"); event.currentTarget.value = ""; }} />
        </div>

        <div>
          <span className="mb-2 block text-sm font-medium text-slate-700">پیش‌نمایش ویدیو</span>
          {item.thumbnailUrl ? (
            <div className="relative inline-flex">
              <img src={fullUrl(item.thumbnailUrl, version)} alt="" className="h-32 w-32 rounded-xl object-cover" />
              <button type="button" onClick={() => onChange({ thumbnailId: undefined, thumbnailUrl: undefined })} className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-1 text-white" aria-label="حذف پیش‌نمایش">
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          ) : (
            <button type="button" disabled={uploadingPoster} onClick={() => posterInput.current?.click()} className="flex h-32 w-40 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-400 hover:border-infinity-primary-light">
              <ImagePlus className="h-6 w-6" aria-hidden />
              {uploadingPoster ? "در حال آپلود..." : "افزودن پیش‌نمایش"}
            </button>
          )}
          <input ref={posterInput} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file, "poster"); event.currentTarget.value = ""; }} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 md:grid-cols-[160px_1fr]">
        <label className="text-sm font-medium text-slate-700">
          مدت نمایش
          <input type="number" min={1000} step={500} value={item.DurationMs} onChange={(event) => onChange({ DurationMs: Number(event.target.value) })} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm" />
          <span className="mt-1 block text-xs font-normal text-slate-400">میلی‌ثانیه</span>
        </label>
        <label className="text-sm font-medium text-slate-700">
          لینک دکمه «مشاهده لینک»
          <input type="text" inputMode="url" dir="ltr" value={item.CtaUrl ?? ""} onChange={(event) => onChange({ CtaUrl: event.target.value })} placeholder="https://example.com یا /pdp/product" className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-left text-sm" />
        </label>
      </div>
      <OverlayEditor overlays={item.Overlays ?? []} onChange={(Overlays) => onChange({ Overlays })} />
    </article>
  );
}

export default function StoryForm({ initialValues, onSubmit, isLoading, submitLabel }: StoryFormProps) {
  const [title, setTitle] = useState(initialValues?.Title ?? "");
  const [isActive, setIsActive] = useState(initialValues?.IsActive ?? false);
  const [sortOrder, setSortOrder] = useState(initialValues?.SortOrder ?? 0);
  const [startAt, setStartAt] = useState(toDateInput(initialValues?.StartAt));
  const [endAt, setEndAt] = useState(toDateInput(initialValues?.EndAt));
  const [coverId, setCoverId] = useState(initialValues?.coverId);
  const [coverUrl, setCoverUrl] = useState(initialValues?.coverUrl);
  const [items, setItems] = useState<StoryFormItemValues[]>(
    initialValues?.Items?.length ? initialValues.Items : [blankItem()],
  );
  const [coverUploading, setCoverUploading] = useState(false);
  const [itemUploads, setItemUploads] = useState(0);
  const coverInput = useRef<HTMLInputElement>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const busy = isLoading || coverUploading || itemUploads > 0;
  const itemIds = useMemo(() => items.map((item) => item.localId), [items]);

  function updateItem(localId: string, patch: Partial<StoryFormItemValues>) {
    setItems((current) => current.map((item) => item.localId === localId ? { ...item, ...patch } : item));
  }

  function moveItem(index: number, direction: -1 | 1) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= items.length) return;
    setItems((current) => arrayMove(current, index, nextIndex));
  }

  function handleDragEnd(event: DragEndEvent) {
    if (!event.over || event.active.id === event.over.id) return;
    setItems((current) => {
      const from = current.findIndex((item) => item.localId === event.active.id);
      const to = current.findIndex((item) => item.localId === event.over?.id);
      return from < 0 || to < 0 ? current : arrayMove(current, from, to);
    });
  }

  async function uploadCover(file: File) {
    setCoverUploading(true);
    try {
      const uploaded = (await uploadFile(file))?.[0];
      if (!uploaded) throw new Error("upload failed");
      setCoverId(uploaded.id);
      setCoverUrl(uploaded.url);
    } catch {
      toast.error("آپلود تصویر جلد ناموفق بود.");
    } finally {
      setCoverUploading(false);
    }
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim()) return void toast.error("عنوان الزامی است.");
    if (items.length < 1 || items.length > MAX_ITEMS) return void toast.error("تعداد آیتم‌ها معتبر نیست.");
    const missing = items.findIndex((item) => !item.mediaId);
    if (missing >= 0) return void toast.error(`رسانه آیتم ${missing + 1} الزامی است.`);
    const invalidDuration = items.findIndex((item) => !Number.isInteger(item.DurationMs) || item.DurationMs < 1000);
    if (invalidDuration >= 0) return void toast.error(`مدت نمایش آیتم ${invalidDuration + 1} معتبر نیست.`);
    if (startAt && endAt && new Date(startAt) > new Date(endAt)) return void toast.error("زمان پایان باید پس از زمان شروع باشد.");

    const payloadItems: StoryItemInput[] = items.map((item) => ({
      ...(item.id ? { id: item.id } : {}),
      ...(item.Key ? { Key: item.Key } : {}),
      MediaType: item.MediaType,
      Media: item.mediaId!,
      Thumbnail: item.thumbnailId ?? null,
      DurationMs: item.DurationMs,
      CtaUrl: item.CtaUrl?.trim() || null,
      Overlays: item.Overlays ?? [],
    }));
    await onSubmit({
      Title: title.trim(),
      IsActive: isActive,
      SortOrder: sortOrder,
      Thumbnail: coverId ?? null,
      StartAt: startAt ? new Date(startAt).toISOString() : null,
      EndAt: endAt ? new Date(endAt).toISOString() : null,
      Items: payloadItems,
    });
  }

  return (
    <form onSubmit={handleSubmit} dir="rtl" className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="space-y-5 lg:col-span-2">
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <label className="mb-2 block text-sm font-medium text-slate-700">عنوان <span className="text-rose-500">*</span></label>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={100} required className="w-full rounded-xl border border-slate-200 px-4 py-2.5 text-sm" placeholder="عنوان استوری" />
        </section>

        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-4">
              {items.map((item, index) => (
                <SortableItemCard
                  key={item.localId}
                  item={item}
                  index={index}
                  count={items.length}
                  version={initialValues?.updatedAt}
                  onChange={(patch) => updateItem(item.localId, patch)}
                  onMove={(direction) => moveItem(index, direction)}
                  onDuplicate={() => setItems((current) => current.length >= MAX_ITEMS ? current : [...current.slice(0, index + 1), { ...item, id: undefined, Key: undefined, localId: clientKey() }, ...current.slice(index + 1)])}
                  onRemove={() => setItems((current) => current.length === 1 ? current : current.filter((entry) => entry.localId !== item.localId))}
                  onUploadState={(uploading) => setItemUploads((value) => Math.max(0, value + (uploading ? 1 : -1)))}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
        <button type="button" disabled={items.length >= MAX_ITEMS} onClick={() => setItems((current) => [...current, blankItem()])} className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-infinity-primary-light px-4 py-3 text-sm text-infinity-primary disabled:opacity-40">
          <Plus className="h-4 w-4" aria-hidden /> افزودن آیتم
        </button>
      </div>

      <aside className="space-y-5">
        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <span className="mb-3 block text-sm font-medium text-slate-700">تصویر جلد داستان</span>
          {coverUrl ? (
            <div className="relative inline-flex">
              <img src={fullUrl(coverUrl, initialValues?.updatedAt)} alt="" className="h-32 w-32 rounded-xl object-cover" />
              <button type="button" onClick={() => { setCoverId(undefined); setCoverUrl(undefined); }} className="absolute -right-2 -top-2 rounded-full bg-rose-500 p-1 text-white" aria-label="حذف تصویر جلد"><X className="h-4 w-4" aria-hidden /></button>
            </div>
          ) : (
            <button type="button" disabled={coverUploading} onClick={() => coverInput.current?.click()} className="flex h-32 w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 text-sm text-slate-400"><ImagePlus className="h-6 w-6" aria-hidden />{coverUploading ? "در حال آپلود..." : "آپلود تصویر جلد"}</button>
          )}
          <input ref={coverInput} type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadCover(file); event.currentTarget.value = ""; }} />
        </section>

        <section className="rounded-2xl bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-700">وضعیت انتشار</span>
            <button type="button" onClick={() => setIsActive((value) => !value)} className="flex items-center gap-2 text-sm">
              {isActive ? <><ToggleRight className="h-6 w-6 text-emerald-500" aria-hidden /><span className="text-emerald-700">فعال</span></> : <><ToggleLeft className="h-6 w-6 text-slate-400" aria-hidden /><span className="text-slate-500">غیرفعال</span></>}
            </button>
          </div>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-infinity-primary py-2.5 text-sm font-medium text-white disabled:opacity-50">{busy ? "در حال ذخیره..." : submitLabel}</button>
        </section>

        <section className="space-y-4 rounded-2xl bg-white p-5 shadow-sm">
          <label className="block text-sm font-medium text-slate-700">ترتیب نمایش<input type="number" min={0} value={sortOrder} onChange={(event) => setSortOrder(Number(event.target.value))} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2" /></label>
          <label className="block text-sm font-medium text-slate-700">شروع نمایش<input type="datetime-local" value={startAt} onChange={(event) => setStartAt(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" dir="ltr" /></label>
          <label className="block text-sm font-medium text-slate-700">پایان نمایش<input type="datetime-local" value={endAt} onChange={(event) => setEndAt(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-200 px-3 py-2 text-left" dir="ltr" /></label>
        </section>
      </aside>
    </form>
  );
}
