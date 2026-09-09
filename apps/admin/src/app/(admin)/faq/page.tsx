"use client";

import { useEffect, useState } from "react";
import toast from "react-hot-toast";
import ContentWrapper from "@/components/SuperAdmin/Layout/ContentWrapper";
import FaqEditor from "@/components/SuperAdmin/Identity/FaqEditor";
import { getSuperAdminSiteFaq } from "@/services/super-admin/site-faq/get";
import { updateSuperAdminSiteFaq } from "@/services/super-admin/site-faq/update";
import type { SiteFaq } from "@/types/site-identity";
import { Card } from "@/components/SuperAdmin/Identity/fields";

export default function SiteFaqPage() {
  const [faq, setFaq] = useState<SiteFaq | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setFaq(await getSuperAdminSiteFaq());
      } catch (error) {
        console.error(error);
        toast.error("خطا در دریافت سوالات متداول. دوباره تلاش کنید");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const saveFaq = async () => {
    if (!faq) return;
    setSaving(true);
    try {
      const saved = await updateSuperAdminSiteFaq(faq);
      setFaq(saved);
      toast.success("سوالات متداول ذخیره شد");
    } catch (error) {
      console.error(error);
      toast.error("خطا در ذخیره سوالات متداول. دوباره تلاش کنید");
    } finally {
      setSaving(false);
    }
  };

  if (loading || !faq) {
    return (
      <ContentWrapper title="سوالات متداول">
        <Card>
          <p className="text-sm text-slate-600">در حال بارگذاری...</p>
        </Card>
      </ContentWrapper>
    );
  }

  return (
    <ContentWrapper title="سوالات متداول">
      <section className="rounded-3xl border border-slate-200 bg-gradient-to-br from-slate-50 via-white to-[#E8F3F4] p-6 shadow-sm">
        <div className="flex flex-col gap-2">
          <span className="text-sm font-semibold text-[#4F8E92]">سوالات متداول فروشگاه</span>
          <h1 className="text-2xl font-semibold text-slate-900">سوالات صفحه FAQ</h1>
          <p className="text-sm text-slate-600">
            همین محتوا در صفحه عمومی سوالات متداول نمایش داده می‌شود.
          </p>
        </div>
      </section>

      <div className="mt-6">
        <FaqEditor faq={faq} setFaq={setFaq} />
      </div>

      <div className="sticky bottom-0 z-10 mt-6 flex justify-end gap-3 rounded-2xl border border-slate-200 bg-white/90 p-4 backdrop-blur">
        <button
          type="button"
          onClick={saveFaq}
          disabled={saving}
          className="rounded-xl bg-[#63A9AE] px-6 py-2.5 text-sm font-medium text-white transition hover:bg-[#4F8E92] disabled:opacity-60"
        >
          {saving ? "در حال ذخیره..." : "ذخیره سوالات متداول"}
        </button>
      </div>
    </ContentWrapper>
  );
}
