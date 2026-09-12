"use client";

import { canonicalIranPhone } from "@repo/auth-core/iran-phone";
import { useAtom, useAtomValue } from "jotai";
import { CheckCircle2, LoaderCircle } from "lucide-react";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { useForm } from "react-hook-form";

import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";
import Modal from "@/components/Kits/Modal";
import { currentUserAtom } from "@/lib/atoms/auth";
import {
  MODEL_APPLICATION_MAX_PHOTO_BYTES,
  MODEL_APPLICATION_PHOTO_ACCEPT,
  submitModelApplication,
} from "@/services/model-applications";

type Fields = {
  fullName: string;
  phone: string;
  email: string;
  age: string;
  heightCm: string;
  city: string;
  experience: string;
};

const HIDDEN_PREFIXES = ["/auth", "/super-admin"];
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function errorText(error: unknown): string {
  if (typeof error === "object" && error && "message" in error) {
    const message = String((error as { message?: unknown }).message || "");
    if (message) return message;
  }
  return "ارسال درخواست انجام نشد. دوباره تلاش کنید.";
}

function validatePhoto(file: File | null): string | true {
  if (!file) return true;
  if (!ALLOWED_PHOTO_TYPES.has(file.type)) {
    return "فقط تصویر JPEG، PNG یا WebP پذیرفته می‌شود.";
  }
  if (file.size > MODEL_APPLICATION_MAX_PHOTO_BYTES) {
    return "حجم هر عکس باید حداکثر ۵ مگابایت باشد.";
  }
  return true;
}

function FilePicker({
  label,
  file,
  error,
  onChange,
}: {
  label: string;
  file: File | null;
  error?: string;
  onChange: (file: File | null) => void;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="w-full">
      <label htmlFor={inputId} className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="flex min-h-12 items-center gap-3 rounded-xl border border-slate-300 bg-white px-3">
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          accept={MODEL_APPLICATION_PHOTO_ACCEPT}
          className="sr-only"
          onChange={(event) => onChange(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="shrink-0 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100"
        >
          انتخاب فایل
        </button>
        <span className="truncate text-sm text-slate-500">
          {file ? file.name : "فایلی انتخاب نشده"}
        </span>
      </div>
      {error && (
        <span className="mt-1 block text-xs text-rose-600" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * The hiring form: react-hook-form, the file pickers, the phone validator and
 * the multipart submit service. `ModelHiringModal` loads this module only after
 * the modal has been opened once, so none of it rides in the client bundle that
 * every storefront route parses before hydration.
 */
export default function ModelHiringModalContent() {
  const pathname = usePathname();
  const user = useAtomValue(currentUserAtom);
  const [open, setOpen] = useAtom(modelHiringModalOpenAtom);
  const [sent, setSent] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [photoOne, setPhotoOne] = useState<File | null>(null);
  const [photoTwo, setPhotoTwo] = useState<File | null>(null);
  const [photoOneError, setPhotoOneError] = useState<string | null>(null);
  const [photoTwoError, setPhotoTwoError] = useState<string | null>(null);
  const [submissionId, setSubmissionId] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<Fields>({
    defaultValues: {
      fullName: "",
      phone: "",
      email: "",
      age: "",
      heightCm: "",
      city: "",
      experience: "",
    },
  });

  useEffect(() => {
    if (user?.Phone) setValue("phone", user.Phone, { shouldDirty: false });
  }, [setValue, user?.Phone]);

  if (!pathname || HIDDEN_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return null;

  const close = () => {
    setOpen(false);
    setSent(false);
    setSubmitError(null);
  };

  const onSubmit = handleSubmit(async (values) => {
    const firstPhotoError = validatePhoto(photoOne);
    const secondPhotoError = validatePhoto(photoTwo);
    setPhotoOneError(firstPhotoError === true ? null : firstPhotoError);
    setPhotoTwoError(secondPhotoError === true ? null : secondPhotoError);
    if (firstPhotoError !== true || secondPhotoError !== true) return;

    setSubmitError(null);
    const activeSubmissionId = submissionId || crypto.randomUUID();
    if (!submissionId) setSubmissionId(activeSubmissionId);
    const formData = new FormData();
    formData.append("submissionId", activeSubmissionId);
    formData.append("fullName", values.fullName.trim());
    formData.append("phone", values.phone.trim());
    formData.append("age", values.age.trim());
    if (values.email.trim()) formData.append("email", values.email.trim());
    if (values.heightCm.trim()) formData.append("heightCm", values.heightCm.trim());
    if (values.city.trim()) formData.append("city", values.city.trim());
    if (values.experience.trim()) formData.append("experience", values.experience.trim());
    formData.append("sourcePath", pathname.split("?")[0] || "/");
    if (photoOne) formData.append("photoOne", photoOne);
    if (photoTwo) formData.append("photoTwo", photoTwo);
    try {
      await submitModelApplication(formData);
      setSent(true);
      reset({
        fullName: "",
        phone: user?.Phone || "",
        email: "",
        age: "",
        heightCm: "",
        city: "",
        experience: "",
      });
      setPhotoOne(null);
      setPhotoTwo(null);
      setSubmissionId(null);
    } catch (error) {
      setSubmitError(errorText(error));
    }
  });

  const requiredMark = <span className="text-rose-600"> *</span>;

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title="استخدام مدل"
      className="max-w-3xl"
      contentClassName="max-h-[min(80vh,40rem)] overflow-y-auto p-6"
    >
      {sent ? (
        <div className="py-8 text-center" role="status" aria-live="polite">
          <CheckCircle2 className="mx-auto mb-3 h-11 w-11 text-emerald-600" aria-hidden="true" />
          <p className="font-semibold text-slate-900">درخواست شما ثبت شد.</p>
          <button
            type="button"
            onClick={close}
            className="mt-6 min-h-11 rounded-xl bg-infinity-primary px-6 py-2.5 font-semibold text-white hover:brightness-95"
          >
            بستن
          </button>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate dir="rtl">
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                نام و نام خانوادگی{requiredMark}
              </span>
              <input
                {...register("fullName", { required: "نام و نام خانوادگی را وارد کنید." })}
                placeholder="مثلاً علی رضایی"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
                aria-invalid={Boolean(errors.fullName)}
              />
              {errors.fullName && (
                <span className="mt-1 block text-xs text-rose-600" role="alert">
                  {errors.fullName.message}
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                شماره تماس{requiredMark}
              </span>
              <input
                {...register("phone", {
                  required: "شماره تماس را وارد کنید.",
                  validate: (value) =>
                    Boolean(canonicalIranPhone(value)) || "شماره تماس معتبر نیست.",
                })}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                dir="ltr"
                placeholder="۰۹۱۲۰۰۰۰۰۰۰"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-left text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
                aria-invalid={Boolean(errors.phone)}
              />
              {errors.phone && (
                <span className="mt-1 block text-xs text-rose-600" role="alert">
                  {errors.phone.message}
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">ایمیل</span>
              <input
                {...register("email")}
                type="email"
                inputMode="email"
                dir="ltr"
                placeholder="example@email.com"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-left text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
              />
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                سن{requiredMark}
              </span>
              <input
                {...register("age", {
                  required: "سن را وارد کنید.",
                  validate: (value) => {
                    const parsed = Number(value);
                    return (
                      (Number.isInteger(parsed) && parsed >= 15 && parsed <= 80) ||
                      "سن باید بین ۱۵ تا ۸۰ باشد."
                    );
                  },
                })}
                type="number"
                inputMode="numeric"
                placeholder="مثلاً ۲۵"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
                aria-invalid={Boolean(errors.age)}
              />
              {errors.age && (
                <span className="mt-1 block text-xs text-rose-600" role="alert">
                  {errors.age.message}
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">
                قد (سانتی‌متر)
              </span>
              <input
                {...register("heightCm", {
                  validate: (value) => {
                    if (!value.trim()) return true;
                    const parsed = Number(value);
                    return (
                      (Number.isInteger(parsed) && parsed >= 100 && parsed <= 250) ||
                      "قد باید بین ۱۰۰ تا ۲۵۰ سانتی‌متر باشد."
                    );
                  },
                })}
                type="number"
                inputMode="numeric"
                placeholder="مثلاً ۱۷۵"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
              />
              {errors.heightCm && (
                <span className="mt-1 block text-xs text-rose-600" role="alert">
                  {errors.heightCm.message}
                </span>
              )}
            </label>
            <label className="block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">شهر</span>
              <input
                {...register("city")}
                placeholder="مثلاً تهران"
                className="min-h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">سابقه کاری</span>
            <textarea
              {...register("experience")}
              rows={4}
              placeholder="توضیح کوتاهی درباره سابقه کاری خود بنویسید"
              className="w-full resize-y rounded-xl border border-slate-300 bg-white px-3 py-3 text-slate-900 outline-none focus:border-infinity-primary focus:ring-2 focus:ring-infinity-primary/20"
            />
          </label>
          <FilePicker
            label="عکس اول (حداکثر ۵ مگابایت)"
            file={photoOne}
            error={photoOneError ?? undefined}
            onChange={(file) => {
              setPhotoOne(file);
              const result = validatePhoto(file);
              setPhotoOneError(result === true ? null : result);
            }}
          />
          <FilePicker
            label="عکس دوم (حداکثر ۵ مگابایت)"
            file={photoTwo}
            error={photoTwoError ?? undefined}
            onChange={(file) => {
              setPhotoTwo(file);
              const result = validatePhoto(file);
              setPhotoTwoError(result === true ? null : result);
            }}
          />
          {submitError && (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              {submitError}
            </p>
          )}
          <div className="flex justify-center pt-2">
            <button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="inline-flex min-h-12 min-w-[12rem] items-center justify-center gap-2 rounded-xl bg-infinity-primary px-6 py-3 font-semibold text-white hover:brightness-95 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {isSubmitting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : null}
              {isSubmitting ? "در حال ارسال..." : "ارسال درخواست"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}
