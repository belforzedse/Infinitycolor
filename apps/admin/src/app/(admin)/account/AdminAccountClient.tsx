"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CentralAuthBrowserError, CentralAuthSession } from "@repo/auth-core/browser";
import {
  centralAuth,
  centralAuthOrigin,
  centralLoginUrl,
  centralLogoutUrl,
} from "@/lib/central-auth";
import UserService from "@/services/user";
import type { MeResponse, UpdateMePayload } from "@/services/user/me";
import { getSidebarItemsForCapabilities } from "@/constants/superAdminSidebar";
import { adminOrigin } from "@/config/admin-env";

const EMPTY_FORM: UpdateMePayload = {
  FirstName: "",
  LastName: "",
  NationalCode: null,
  BirthDate: null,
  Sex: null,
  Bio: null,
};

function usableEmail(user: MeResponse | null): string | null {
  const email = String(user?.Email || user?.email || "").trim();
  if (!email || /identity\.invalid$|placeholder\.local$|^strapi-\d+@/i.test(email)) return null;
  return email;
}

function needsReauth(error: unknown): boolean {
  const authError = error as Partial<CentralAuthBrowserError>;
  return authError.status === 401 || authError.code === "SESSION_NOT_FRESH";
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "نامشخص";
  return new Intl.DateTimeFormat("fa-IR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export default function AdminAccountClient() {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [form, setForm] = useState<UpdateMePayload>(EMPTY_FORM);
  const [sessions, setSessions] = useState<CentralAuthSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [sessionBusy, setSessionBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const redirectForReauth = useCallback(() => {
    window.location.replace(centralLoginUrl("/account"));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [me, activeSessions] = await Promise.all([
        UserService.me(true),
        centralAuth.listSessions(),
      ]);
      setUser(me);
      setForm({
        FirstName: me.FirstName || "",
        LastName: me.LastName || "",
        NationalCode: me.NationalCode || null,
        BirthDate: me.BirthDate || null,
        Sex: me.Sex ?? null,
        Bio: me.Bio || null,
      });
      setSessions(activeSessions);
    } catch (cause) {
      if (needsReauth(cause)) return redirectForReauth();
      setError(cause instanceof Error ? cause.message : "دریافت اطلاعات حساب ناموفق بود");
    } finally {
      setLoading(false);
    }
  }, [redirectForReauth]);

  useEffect(() => {
    void load();
  }, [load]);

  const accessibleSections = useMemo(
    () =>
      getSidebarItemsForCapabilities(user?.capabilities, user?.adminRole).map(
        (item) => item.label,
      ),
    [user?.adminRole, user?.capabilities],
  );

  const updateField = <K extends keyof UpdateMePayload>(key: K, value: UpdateMePayload[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const saveProfile = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSuccess(null);
    try {
      const updated = await UserService.updateMe(form);
      setUser(updated);
      setSuccess("اطلاعات حساب با موفقیت ذخیره شد.");
    } catch (cause) {
      if (needsReauth(cause)) return redirectForReauth();
      setError(cause instanceof Error ? cause.message : "ذخیره اطلاعات ناموفق بود");
    } finally {
      setSaving(false);
    }
  };

  const refreshSessions = async () => setSessions(await centralAuth.listSessions());

  const revokeOne = async (session: CentralAuthSession) => {
    if (!window.confirm("این نشست از حساب خارج شود؟")) return;
    setSessionBusy(session.id);
    setError(null);
    try {
      await centralAuth.revokeSession(session.token);
      const token = await centralAuth.tokenManager.getToken({ forceRefresh: true });
      if (!token) return redirectForReauth();
      await refreshSessions();
      setSuccess("نشست انتخاب‌شده لغو شد.");
    } catch (cause) {
      if (needsReauth(cause)) return redirectForReauth();
      setError(cause instanceof Error ? cause.message : "لغو نشست ناموفق بود");
    } finally {
      setSessionBusy(null);
    }
  };

  const revokeOthers = async () => {
    if (!window.confirm("همه نشست‌های دیگر لغو شوند؟")) return;
    setSessionBusy("others");
    try {
      await centralAuth.revokeOtherSessions();
      await refreshSessions();
      setSuccess("همه نشست‌های دیگر لغو شدند.");
    } catch (cause) {
      if (needsReauth(cause)) return redirectForReauth();
      setError(cause instanceof Error ? cause.message : "لغو نشست‌ها ناموفق بود");
    } finally {
      setSessionBusy(null);
    }
  };

  const signOutEverywhere = async () => {
    if (!window.confirm("از همه دستگاه‌ها خارج شوید؟")) return;
    setSessionBusy("all");
    try {
      await centralAuth.revokeSessions();
    } finally {
      window.location.replace(centralLogoutUrl());
    }
  };

  const passwordUrl = new URL("/auth/forgot-password", centralAuthOrigin);
  passwordUrl.searchParams.set("returnTo", new URL("/account", adminOrigin()).toString());

  if (loading) {
    return (
      <div className="rounded-2xl border bg-white p-8 text-center" role="status">
        در حال دریافت حساب...
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-4 sm:space-y-6" dir="rtl">
      <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h1 className="text-xl font-semibold text-slate-900 sm:text-2xl">حساب مدیریتی</h1>
        <p className="mt-2 text-sm text-slate-500">
          اطلاعات هویتی و نشست‌های فعال حساب خود را مدیریت کنید.
        </p>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700" role="alert">
          {error}
        </div>
      )}
      {success && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700" role="status">
          {success}
        </div>
      )}

      <form
        onSubmit={saveProfile}
        className="grid min-w-0 gap-4 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5 md:grid-cols-2"
      >
        <h2 className="text-lg font-semibold text-slate-900 md:col-span-2">پروفایل</h2>
        <label className="space-y-2 text-sm text-slate-700">
          نام
          <input required className="input" value={form.FirstName} onChange={(event) => updateField("FirstName", event.target.value)} />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          نام خانوادگی
          <input required className="input" value={form.LastName} onChange={(event) => updateField("LastName", event.target.value)} />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          کد ملی
          <input className="input" inputMode="numeric" value={form.NationalCode || ""} onChange={(event) => updateField("NationalCode", event.target.value || null)} />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          تاریخ تولد
          <input className="input" type="date" value={form.BirthDate || ""} onChange={(event) => updateField("BirthDate", event.target.value || null)} />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          جنسیت
          <select className="input" value={form.Sex === null ? "" : String(form.Sex)} onChange={(event) => updateField("Sex", event.target.value === "" ? null : event.target.value === "true")}>
            <option value="">ثبت نشده</option>
            <option value="true">مرد</option>
            <option value="false">زن</option>
          </select>
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          شماره همراه
          <input className="input" value={user?.Phone || ""} readOnly disabled />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          ایمیل
          <input className="input" value={usableEmail(user) || "ثبت نشده"} readOnly disabled />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          وضعیت تایید هویت
          <input className="input" value={user?.IsVerified ? "تایید شده" : "تایید نشده"} readOnly disabled />
        </label>
        <label className="space-y-2 text-sm text-slate-700">
          وضعیت تایید ایمیل
          <input className="input" value={!usableEmail(user) ? "ایمیل قابل استفاده ثبت نشده" : user?.confirmed ? "تایید شده" : "تایید نشده"} readOnly disabled />
        </label>
        <label className="space-y-2 text-sm text-slate-700 md:col-span-2">
          درباره
          <textarea className="input min-h-28" value={form.Bio || ""} onChange={(event) => updateField("Bio", event.target.value || null)} />
        </label>
        <div className="grid grid-cols-1 gap-3 sm:flex sm:flex-wrap md:col-span-2">
          <button disabled={saving} className="btn btn-primary w-full px-5 py-2 sm:w-auto" type="submit">
            {saving ? "در حال ذخیره..." : "ذخیره پروفایل"}
          </button>
          <a className="btn btn-outline w-full px-5 py-2 sm:w-auto" href={passwordUrl.toString()}>
            تغییر رمز با کد یک‌بارمصرف
          </a>
        </div>
      </form>

      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <h2 className="text-lg font-semibold text-slate-900">نقش و دسترسی موثر</h2>
        <p className="mt-2 text-sm text-slate-600">نقش: <strong>{user?.roleName || "نامشخص"}</strong></p>
        <div className="mt-3 flex flex-wrap gap-2">
          {accessibleSections.map((section) => (
            <span key={section} className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700">{section}</span>
          ))}
        </div>
        <details className="mt-4 min-w-0 overflow-hidden rounded-xl border border-slate-200 p-3">
          <summary className="cursor-pointer break-words text-sm font-medium text-slate-700">
            مجوزهای موثر Strapi ({user?.effectivePermissions?.length || 0})
          </summary>
          <ul className="mt-3 max-h-64 max-w-full space-y-1 overflow-auto font-mono text-xs text-slate-600" dir="ltr">
            {(user?.effectivePermissions || []).map((permission) => <li key={permission}>{permission}</li>)}
          </ul>
        </details>
        <p className="mt-3 text-xs text-slate-500">مجوز نهایی هر عملیات در Strapi دوباره بررسی می‌شود.</p>
      </section>

      <section className="min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
        <div className="flex min-w-0 flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-slate-900">نشست‌های فعال</h2>
            <p className="mt-1 text-sm text-slate-500">توکن نشست نمایش داده یا ذخیره نمی‌شود.</p>
          </div>
          <div className="grid w-full grid-cols-1 gap-2 sm:flex sm:w-auto sm:flex-wrap">
            <button type="button" className="btn btn-outline w-full px-4 py-2 sm:w-auto" disabled={Boolean(sessionBusy)} onClick={revokeOthers}>لغو نشست‌های دیگر</button>
            <button type="button" className="btn w-full border border-red-200 px-4 py-2 text-red-700 sm:w-auto" disabled={Boolean(sessionBusy)} onClick={signOutEverywhere}>خروج از همه دستگاه‌ها</button>
          </div>
        </div>
        <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
          {sessions.length === 0 ? (
            <p className="text-sm text-slate-500">نشست فعالی یافت نشد.</p>
          ) : (
            sessions.map((session) => (
              <article key={session.id} className="flex w-full min-w-0 max-w-full flex-col gap-3 overflow-hidden rounded-xl border border-slate-200 p-3 sm:p-4 md:flex-row md:items-center md:justify-between">
                <div className="w-full min-w-0">
                  <p className="break-words text-sm font-medium leading-6 text-slate-800 sm:truncate">{session.userAgent || "دستگاه ناشناس"}</p>
                  <p className="mt-1 flex flex-wrap gap-x-2 gap-y-1 text-xs leading-5 text-slate-500">
                    <span>IP: {session.ipAddress || "نامشخص"}</span>
                    <span>ایجاد: {formatDate(session.createdAt)}</span>
                    <span>انقضا: {formatDate(session.expiresAt)}</span>
                  </p>
                </div>
                <button type="button" className="btn btn-outline w-full shrink-0 px-4 py-2 sm:w-auto" disabled={Boolean(sessionBusy)} onClick={() => revokeOne(session)}>
                  {sessionBusy === session.id ? "در حال لغو..." : "لغو نشست"}
                </button>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
