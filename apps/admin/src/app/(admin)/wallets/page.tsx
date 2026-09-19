"use client";

import { useEffect, useState } from "react";
import { useDebouncedCallback } from "use-debounce";
import { apiClient } from "@/services";
import WalletAdjustCard from "@/app/(admin)/users/edit/[id]/WalletAdjustCard";
import TopupReviewQueue from "./TopupReviewQueue";
import { useCan } from "@/hooks/useCan";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import {
  formatCustomerName,
  unwrapCustomerSearchResults,
  type WalletCustomer,
} from "./customerSearch";

export default function WalletAdministrationPage() {
  const canAdjust = useCan("wallet.adjust");
  const canReadHistory = useCan("wallet.history.read");
  const { user: currentUser } = useCurrentUser();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<WalletCustomer[]>([]);
  const [selected, setSelected] = useState<WalletCustomer | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSearch = async (rawQuery: string) => {
    const normalized = rawQuery.trim();
    if (normalized.length < 2) {
      setResults((current) => (current.length === 0 ? current : []));
      setHasSearched(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await apiClient.get<WalletCustomer[]>(
        `/sp/customers/search?q=${encodeURIComponent(normalized)}&pageSize=20`,
        { cache: "no-store" },
      );
      setResults(unwrapCustomerSearchResults(response));
      setHasSearched(true);
    } catch (cause) {
      setResults([]);
      setHasSearched(true);
      setError(
        getUserFacingErrorMessage(cause, "جستجو ناموفق بود. دوباره تلاش کنید."),
      );
    } finally {
      setLoading(false);
    }
  };

  const debouncedSearch = useDebouncedCallback((nextQuery: string) => {
    void runSearch(nextQuery);
  }, 500);

  useEffect(() => {
    debouncedSearch(query);
  }, [query, debouncedSearch]);

  useEffect(() => {
    return () => {
      debouncedSearch.cancel();
    };
  }, [debouncedSearch]);

  const search = async (event: React.FormEvent) => {
    event.preventDefault();
    const normalized = query.trim();
    if (normalized.length < 2) {
      setError("حداقل دو نویسه برای جستجو وارد کنید.");
      setResults([]);
      setHasSearched(false);
      return;
    }
    debouncedSearch.cancel();
    await runSearch(normalized);
  };

  const selectedName = selected ? formatCustomerName(selected) : "";
  const isOwnWallet =
    selected != null &&
    Number.isInteger(Number(currentUser?.id)) &&
    Number(currentUser?.id) === selected.id;

  return (
    <main className="space-y-5" dir="rtl">
      <header>
        <h1 className="text-2xl font-bold text-neutral-900">مدیریت کیف پول کاربران</h1>
        <p className="mt-2 text-sm text-neutral-600">
          جستجو با نام، نام خانوادگی یا شماره همراه — با ۰۹۱۲، ۹۱۲ یا +۹۸. مشتریان و مدیران هر دو
          در نتایج هستند. تغییر موجودی خودتان مجاز نیست.
        </p>
      </header>

      <form onSubmit={search} className="rounded-2xl border border-neutral-200 bg-white p-4">
        <label className="text-sm font-medium text-neutral-700" htmlFor="wallet-customer-search">
          نام یا شماره همراه
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative min-h-11 flex-1">
            <input
              id="wallet-customer-search"
              data-testid="wallet-customer-search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setError(null);
              }}
              placeholder="مثلاً ۰۹۱۲۳۳۸۱۰۹۸ یا نام و نام خانوادگی"
              className="min-h-11 w-full rounded-xl border border-neutral-300 px-3"
              autoComplete="off"
              inputMode="search"
              enterKeyHint="search"
              autoCorrect="off"
              spellCheck={false}
            />
            {loading && (
              <div className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-infinity-primary border-t-transparent" />
              </div>
            )}
          </div>
          <button
            type="submit"
            disabled={loading}
            className="min-h-11 rounded-xl bg-infinity-primary px-5 font-semibold text-white disabled:opacity-50"
          >
            {loading ? "در حال جستجو…" : "جستجو"}
          </button>
        </div>
        {error && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {error}
          </p>
        )}
      </form>

      {selected && (
        <section
          className="flex flex-col gap-3 rounded-2xl border border-green-200 bg-green-50 p-4 sm:flex-row sm:items-center sm:justify-between"
          data-testid="wallet-selected-customer"
          aria-label={`کاربر انتخاب‌شده ${selectedName || selected.phone || selected.id}`}
        >
          <div>
            <p className="text-xs text-green-700">کاربر انتخاب‌شده</p>
            <p className="font-semibold text-green-900" data-testid="wallet-selected-name">
              {selectedName || "بدون نام"}
            </p>
            <p className="text-sm text-green-800" dir="ltr" data-testid="wallet-selected-phone">
              {selected.phone || "—"}
            </p>
          </div>
          <button
            type="button"
            className="self-start text-sm text-red-600 hover:text-red-800"
            onClick={() => setSelected(null)}
          >
            حذف انتخاب
          </button>
        </section>
      )}

      {hasSearched && results.length === 0 && !loading && (
        <p className="rounded-2xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
          کاربری یافت نشد.
        </p>
      )}

      {results.length > 0 && (
        <section className="grid gap-2 rounded-2xl border border-neutral-200 bg-white p-4">
          {results.map((customer) => {
            const name = formatCustomerName(customer);
            const isSelected = selected?.id === customer.id;
            return (
              <button
                key={customer.id}
                type="button"
                data-testid="wallet-customer-result"
                data-selected={isSelected ? "true" : "false"}
                aria-pressed={isSelected}
                onClick={() => setSelected(customer)}
                className={`flex min-h-12 items-center justify-between rounded-xl border px-4 text-right ${
                  isSelected
                    ? "border-infinity-primary bg-infinity-primary-lighter/30"
                    : "border-neutral-200 hover:border-infinity-primary"
                }`}
              >
                <span className="font-medium text-neutral-900">{name || "بدون نام"}</span>
                <span className="text-sm text-neutral-500" dir="ltr">
                  {customer.phone || "—"}
                </span>
              </button>
            );
          })}
        </section>
      )}

      {canReadHistory && (
        <TopupReviewQueue
          onSelectOwner={(userId) => {
            // Jump straight to that customer's wallet; the card is the only
            // place a stranded top-up can actually be settled.
            setSelected({ id: userId } as WalletCustomer);
            setQuery("");
            setResults([]);
            setHasSearched(false);
          }}
        />
      )}

      {selected && (
        <section aria-label={`کیف پول ${selectedName || selected.phone || selected.id}`}>
          {canAdjust ? (
            <WalletAdjustCard
              userId={selected.id}
              customerName={selectedName || undefined}
              customerPhone={selected.phone}
              allowAdjust={!isOwnWallet}
            />
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
