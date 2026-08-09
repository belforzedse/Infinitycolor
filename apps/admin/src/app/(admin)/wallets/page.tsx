"use client";

import { useState } from "react";
import { apiClient } from "@/services";
import WalletAdjustCard from "@/app/(admin)/users/edit/[id]/WalletAdjustCard";
import { useCan } from "@/hooks/useCan";

type CustomerResult = {
  id: number;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
};

export default function WalletAdministrationPage() {
  const canAdjust = useCan("wallet.adjust");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CustomerResult[]>([]);
  const [selected, setSelected] = useState<CustomerResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized.length < 2) {
      setError("حداقل دو نویسه برای جستجو وارد کنید.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<{ data: CustomerResult[] }>(
        `/sp/customers/search?q=${encodeURIComponent(normalized)}&pageSize=20`,
        { cache: "no-store" },
      );
      setResults(((response as any)?.data ?? []) as CustomerResult[]);
    } catch (cause) {
      setResults([]);
      setError(cause instanceof Error ? cause.message : "جستجوی مشتری ناموفق بود.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="space-y-5" dir="rtl">
      <header>
        <h1 className="text-2xl font-bold text-neutral-900">مدیریت کیف پول مشتریان</h1>
        <p className="mt-2 text-sm text-neutral-600">
          جستجو فقط نام و شماره همراه مشتری را نمایش می‌دهد. تغییر موجودی خود مدیر مجاز نیست.
        </p>
      </header>

      <form onSubmit={search} className="rounded-2xl border border-neutral-200 bg-white p-4">
        <label className="text-sm font-medium text-neutral-700" htmlFor="wallet-customer-search">
          نام یا شماره همراه مشتری
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            id="wallet-customer-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="min-h-11 flex-1 rounded-xl border border-neutral-300 px-3"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 rounded-xl bg-infinity-primary px-5 font-semibold text-white disabled:opacity-50"
          >
            {loading ? "در حال جستجو…" : "جستجو"}
          </button>
        </div>
        {error && <p className="mt-2 text-sm text-red-600" role="alert">{error}</p>}
      </form>

      {results.length > 0 && (
        <section className="grid gap-2 rounded-2xl border border-neutral-200 bg-white p-4">
          {results.map((customer) => {
            const name = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim();
            return (
              <button
                key={customer.id}
                type="button"
                onClick={() => setSelected(customer)}
                className="flex min-h-12 items-center justify-between rounded-xl border border-neutral-200 px-4 text-right hover:border-infinity-primary"
              >
                <span className="font-medium text-neutral-900">{name || "بدون نام"}</span>
                <span className="text-sm text-neutral-500" dir="ltr">{customer.phone || "—"}</span>
              </button>
            );
          })}
        </section>
      )}

      {selected && (
        <section aria-label={`کیف پول ${selected.phone ?? selected.id}`}>
          {canAdjust ? (
            <WalletAdjustCard userId={selected.id} />
          ) : (
            <p className="rounded-2xl border border-neutral-200 bg-white p-5 text-neutral-600">
              حساب شما فقط اجازه مشاهده کیف پول را دارد.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
