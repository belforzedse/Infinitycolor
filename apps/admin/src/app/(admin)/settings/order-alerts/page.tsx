"use client";

import { useEffect, useState } from "react";
import { toast } from "react-hot-toast";
import { FiPlus, FiTrash2 } from "react-icons/fi";

import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import {
  defaultOrderAlertSettings,
  getOrderAlertSettings,
  updateOrderAlertSettings,
  type OrderAlertRecipient,
  type OrderAlertSettings,
} from "@/services/super-admin/settings/orderAlerts";
import logger from "@/utils/logger";

const MAX_RECIPIENTS = 20;

/**
 * Mirrors `normalizeIranMobile` on the backend so a typo is caught before the
 * round-trip; the server still normalises and drops anything invalid.
 */
function isValidIranMobile(raw: string): boolean {
  const english = raw.replace(/[۰-۹٠-٩]/g, (char) => {
    const code = char.charCodeAt(0);
    const persianZero = "۰".charCodeAt(0);
    return String(
      code >= persianZero && code <= persianZero + 9
        ? code - persianZero
        : code - "٠".charCodeAt(0),
    );
  });
  const cleaned = english.replace(/[\s().-]/g, "");
  return /^(\+98|0098|98|0)?9\d{9}$/.test(cleaned);
}

export default function OrderAlertSettingsPage() {
  const [settings, setSettings] = useState<OrderAlertSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const load = async () => {
      try {
        setSettings(await getOrderAlertSettings());
      } catch (error) {
        logger.error("[OrderAlertSettings] Failed to fetch settings", { error });
        toast.error("خطا در دریافت تنظیمات پیامک");
        setSettings(defaultOrderAlertSettings());
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, []);

  const patchRecipient = (index: number, patch: Partial<OrderAlertRecipient>) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            recipients: current.recipients.map((recipient, i) =>
              i === index ? { ...recipient, ...patch } : recipient,
            ),
          }
        : current,
    );
  };

  const addRecipient = () => {
    setSettings((current) =>
      current && current.recipients.length < MAX_RECIPIENTS
        ? {
            ...current,
            recipients: [...current.recipients, { label: "", phone: "", enabled: true }],
          }
        : current,
    );
  };

  const removeRecipient = (index: number) => {
    setSettings((current) =>
      current
        ? { ...current, recipients: current.recipients.filter((_, i) => i !== index) }
        : current,
    );
  };

  const save = async () => {
    if (!settings) return;

    const filled = settings.recipients.filter((recipient) => recipient.phone.trim() !== "");
    const invalid = filled.filter((recipient) => !isValidIranMobile(recipient.phone));
    if (invalid.length > 0) {
      toast.error("شماره موبایل نامعتبر است. نمونه درست: ۰۹۱۲۱۲۳۴۵۶۷");
      return;
    }

    try {
      setSaving(true);
      const saved = await updateOrderAlertSettings({
        enabled: settings.enabled,
        recipients: filled,
      });
      setSettings(saved);
      toast.success("تنظیمات پیامک ذخیره شد");
    } catch (error) {
      logger.error("[OrderAlertSettings] Failed to save settings", { error });
      toast.error("خطا در ذخیره تنظیمات پیامک");
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div>در حال بارگذاری...</div>;
  if (!settings) return <div>تنظیمات یافت نشد</div>;

  return (
    <ContentWrapper title="پیامک اطلاع‌رسانی سفارش">
      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold text-slate-900">
          اطلاع‌رسانی ورود سفارش به «در حال انجام»
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          هر بار که یک سفارش به وضعیت «در حال انجام» می‌رسد، برای شماره‌های زیر پیامک
          فرستاده می‌شود. این فهرست داخلی است و در سایت نمایش داده نمی‌شود.
        </p>

        <label className="mt-4 flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) =>
              setSettings((current) =>
                current ? { ...current, enabled: event.target.checked } : current,
              )
            }
            className="h-4 w-4 rounded border-slate-300"
          />
          ارسال پیامک فعال باشد
        </label>
      </section>

      <section className="mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">شماره‌های دریافت‌کننده</h3>
          <button
            type="button"
            onClick={addRecipient}
            disabled={settings.recipients.length >= MAX_RECIPIENTS}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <FiPlus className="h-4 w-4" />
            افزودن شماره
          </button>
        </div>

        {settings.recipients.length === 0 ? (
          <p className="mt-4 rounded-xl border border-dashed border-slate-200 p-4 text-sm text-slate-500">
            هنوز شماره‌ای ثبت نشده است.
          </p>
        ) : (
          <ul className="mt-4 flex flex-col gap-3">
            {settings.recipients.map((recipient, index) => {
              const invalid =
                recipient.phone.trim() !== "" && !isValidIranMobile(recipient.phone);
              return (
                <li
                  key={index}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3"
                >
                  <input
                    type="text"
                    value={recipient.label}
                    placeholder="نام (اختیاری)"
                    onChange={(event) => patchRecipient(index, { label: event.target.value })}
                    className="min-w-[8rem] flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
                  />
                  <input
                    type="tel"
                    dir="ltr"
                    value={recipient.phone}
                    placeholder="09121234567"
                    onChange={(event) => patchRecipient(index, { phone: event.target.value })}
                    className={`min-w-[10rem] flex-1 rounded-lg border px-3 py-2 text-sm ${
                      invalid ? "border-rose-400 bg-rose-50" : "border-slate-200"
                    }`}
                  />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={recipient.enabled}
                      onChange={(event) =>
                        patchRecipient(index, { enabled: event.target.checked })
                      }
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    فعال
                  </label>
                  <button
                    type="button"
                    onClick={() => removeRecipient(index)}
                    aria-label="حذف شماره"
                    className="rounded-lg border border-slate-200 p-2 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
                  >
                    <FiTrash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="mt-5 flex justify-end">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded-lg bg-[#4F8E92] px-5 py-2 text-sm font-semibold text-white transition hover:bg-[#41777a] disabled:opacity-60"
          >
            {saving ? "در حال ذخیره..." : "ذخیره تنظیمات"}
          </button>
        </div>
      </section>
    </ContentWrapper>
  );
}
