"use client";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import WalletBalance from "@/components/User/Wallet/Balance";
import IncreaseBalance from "@/components/User/Wallet/IncreaseBalance";
import TransactionsList from "@/components/User/Wallet/TransactionsList";
import TransactionsIcon from "@/components/User/Icons/TransactionsIcon";
import UserContainer from "@/components/layout/UserContainer";
import AccountQuickLinks from "@/components/User/Account/QuickLinks";
import { AlertCircleIcon, CheckIcon, InfoIcon } from "lucide-react";
import WalletService, {
  splitWalletLedger,
  type WalletTopupOptions,
  type WalletTopupStatus,
} from "@/services/wallet";
import type { WalletLedgerUiRow } from "@/services/wallet/ledger";
import { getUserFacingErrorMessage } from "@/utils/userErrorMessage";
import { StorefrontAccountShell } from "@/components/storefront/StorefrontAccountShell";
import { isWalletTopupUiEnabled } from "@/config/walletTopup";

function StatusBanner({
  variant,
  title,
  description,
}: {
  variant: "success" | "error";
  title: string;
  description: string;
}) {
  const styles =
    variant === "success"
      ? "border-green-200 bg-green-50 text-green-800"
      : "border-red-200 bg-red-50 text-red-800";

  const Icon = variant === "success" ? CheckIcon : AlertCircleIcon;

  return (
    <div
      className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm md:text-base ${styles}`}
    >
      <Icon className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{title}</span>
        <span className="text-xs md:text-sm">{description}</span>
      </div>
    </div>
  );
}

function ChargingDisabledNotice({ reason }: { reason: WalletTopupOptions["disabledReason"] }) {
  return (
    <div
      id="wallet-charge-disabled-notice"
      className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 md:text-base"
    >
      <InfoIcon className="mt-0.5 h-5 w-5 flex-shrink-0" />
      <span className="font-semibold">
        {reason === "no_gateway"
          ? "درگاه پرداختی برای شارژ کیف پول در دسترس نیست."
          : "در حال حاضر امکان شارژ کیف پول وجود ندارد."}
      </span>
    </div>
  );
}

export default function WalletPage() {
  const topupUiEnabled = isWalletTopupUiEnabled();
  const [isTransactionsHistoryOpen, setIsTransactionsHistoryOpen] = useState(false);
  const [depositList, setDepositList] = useState<WalletLedgerUiRow[]>([]);
  const [purchaseList, setPurchaseList] = useState<WalletLedgerUiRow[]>([]);
  const [transactionsLoading, setTransactionsLoading] = useState(false);
  const [transactionsError, setTransactionsError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const router = useRouter();
  const status = searchParams.get("status");
  const reason = searchParams.get("reason");
  const code = searchParams.get("code");
  const topupReference = searchParams.get("topup");

  const [topupOptions, setTopupOptions] = useState<WalletTopupOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(topupUiEnabled);
  const [trackedTopup, setTrackedTopup] = useState<string | null>(topupReference);
  const [topupStatus, setTopupStatus] = useState<WalletTopupStatus | null>(null);
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);

  // What the store will accept is server state, not a constant in the bundle.
  useEffect(() => {
    // This UI-only kill switch deliberately does not affect callback/status
    // handling below. Existing payments can still finish while new ones cannot
    // be started from the storefront.
    if (!topupUiEnabled) {
      return undefined;
    }

    let cancelled = false;
    (async () => {
      try {
        const options = await WalletService.getTopupOptions();
        if (!cancelled) setTopupOptions(options);
      } catch {
        // Treated as "not offered right now" rather than an error page: the
        // rest of the wallet still works.
        if (!cancelled) setTopupOptions(null);
      } finally {
        if (!cancelled) setOptionsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [topupUiEnabled]);

  /**
   * The query string the provider sent the customer back with is display only.
   * The real outcome is read from the server, and polled while it is still
   * being established — a bank can confirm after the browser has returned.
   */
  useEffect(() => {
    if (!trackedTopup) return undefined;
    let cancelled = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      attempts += 1;
      try {
        const current = await WalletService.getTopupStatus(trackedTopup);
        if (cancelled) return;
        setTopupStatus(current);
        if (current?.status === "Success") {
          // No optimistic credit: the balance is re-read from the server.
          setBalanceRefreshKey((key) => key + 1);
          return;
        }
        if (current && ["Failed", "Cancelled"].includes(current.status)) return;
      } catch {
        if (cancelled) return;
      }
      if (attempts < 12) timer = setTimeout(poll, 2_500);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackedTopup]);

  const statusConfig = useMemo(() => {
    // Server-confirmed state wins over whatever the redirect claimed.
    if (topupStatus?.status === "Success") {
      return {
        variant: "success" as const,
        title: "شارژ کیف پول با موفقیت انجام شد",
        description: "موجودی شما به‌روزرسانی شد. می‌توانید از آن در خرید بعدی استفاده کنید.",
      };
    }
    if (topupStatus && ["Pending", "Processing", "Unknown"].includes(topupStatus.status)) {
      return {
        variant: "error" as const,
        title: "پرداخت در حال بررسی است",
        description: "پرداخت در حال بررسی است. لطفاً دوباره پرداخت نکنید.",
      };
    }
    if (topupStatus && ["Failed", "Cancelled"].includes(topupStatus.status)) {
      return {
        variant: "error" as const,
        title: "پرداخت ناموفق بود",
        description: "پرداخت انجام نشد. مبلغی از حساب شما کسر نشده است.",
      };
    }

    if (status === "success") {
      return {
        variant: "success" as const,
        title: "شارژ کیف پول با موفقیت انجام شد",
        description: "موجودی شما به‌روزرسانی شد. می‌توانید از آن در خرید بعدی استفاده کنید.",
      };
    }

    if (status === "failure") {
      const reasonMessage =
        reason === "not_found"
          ? "درخواست شارژ پیدا نشد. لطفاً دوباره امتحان کنید."
          : reason === "verify"
            ? "تأیید پرداخت توسط بانک ناموفق بود. لطفاً دوباره تلاش کنید."
            : reason === "settle"
              ? "مشکل در ثبت نهایی پرداخت. در صورت کسر وجه با پشتیبانی تماس بگیرید."
              : reason === "wallet_update"
                ? "پرداخت انجام شد اما به‌روزرسانی کیف پول ناموفق بود. لطفاً با پشتیبانی تماس بگیرید."
                : reason === "internal"
                  ? "در حین پردازش پرداخت خطایی رخ داد."
                  : code
                    ? `پرداخت توسط بانک با خطا (${code}) مواجه شد.`
                    : "پرداخت ناموفق بود. لطفاً دوباره تلاش کنید.";

      return {
        variant: "error" as const,
        title: "پرداخت ناموفق بود",
        description: reasonMessage,
      };
    }

    if (status === "pending") {
      return {
        variant: "error" as const,
        title: "پرداخت در انتظار تأیید",
        description:
          "نتیجه پرداخت مشخص نشد. اگر مبلغ از حساب شما کسر شده است، با پشتیبانی تماس بگیرید.",
      };
    }

    return null;
  }, [status, reason, code, topupStatus]);

  useEffect(() => {
    if (statusConfig) {
      const cleanup = setTimeout(() => {
        const params = new URLSearchParams(Array.from(searchParams.entries()));
        params.delete("status");
        params.delete("reason");
        params.delete("code");
        params.delete("topup");
        router.replace(`/wallet${params.toString() ? `?${params}` : ""}`);
      }, 6000);
      return () => clearTimeout(cleanup);
    }
    return undefined;
  }, [router, searchParams, statusConfig]);

  // Fetch transactions when transactions history is opened
  useEffect(() => {
    const fetchTransactions = async () => {
      if (!isTransactionsHistoryOpen) return;

      try {
        setTransactionsLoading(true);
        setTransactionsError(null);

        const entries = await WalletService.getMyWalletTransactions();
        const { deposits, purchases } = splitWalletLedger(entries);
        setDepositList(deposits);
        setPurchaseList(purchases);
      } catch (err: unknown) {
        console.error("Failed to fetch transactions:", err);
        setTransactionsError(
          getUserFacingErrorMessage(err, "خطا در دریافت تراکنش‌ها. دوباره تلاش کنید."),
        );
        setDepositList([]);
        setPurchaseList([]);
      } finally {
        setTransactionsLoading(false);
      }
    };

    fetchTransactions();
  }, [isTransactionsHistoryOpen]);

  return (
    <UserContainer className="flex flex-col gap-6 py-6 lg:py-10" dir="rtl">
      {statusConfig ? (
        <StatusBanner
          variant={statusConfig.variant}
          title={statusConfig.title}
          description={statusConfig.description}
        />
      ) : null}
      {!optionsLoading && !topupOptions?.enabled ? (
        <ChargingDisabledNotice reason={topupOptions?.disabledReason ?? "disabled"} />
      ) : null}
      <StorefrontAccountShell contentClassName="flex flex-col gap-6">
        <AccountQuickLinks />

        <div className="flex flex-col gap-2">
          <h1 className="text-foreground-primary text-2xl font-semibold lg:text-3xl">کیف پول</h1>
          <p className="text-sm text-slate-500 lg:text-base">
            موجودی خود را مدیریت کنید و حساب را به‌راحتی شارژ یا پیگیری کنید.
          </p>
        </div>

        <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-4 shadow-sm lg:flex-row lg:items-center lg:justify-between lg:px-6">
          <span className="text-sm text-slate-600 lg:text-base">
            {isTransactionsHistoryOpen
              ? "نمایش سوابق و جزئیات تراکنش‌های کیف پول."
              : "برای مشاهده تاریخچه تراکنش‌ها یا ثبت شارژ جدید اقدام کنید."}
          </span>
          <button
            type="button"
            onClick={() => setIsTransactionsHistoryOpen((prev) => !prev)}
            className="flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm text-slate-600 transition hover:border-infinity-primary-lighter/60 hover:text-infinity-primary"
          >
            <TransactionsIcon className="h-5 w-5" />
            <span>{isTransactionsHistoryOpen ? "نمایش موجودی و شارژ" : "مشاهده سوابق تراکنش"}</span>
          </button>
        </div>

        <div className="flex w-full flex-col gap-6 lg:flex-row lg:gap-5">
          {isTransactionsHistoryOpen ? (
            transactionsLoading ? (
              <div className="flex w-full items-center justify-center rounded-xl border border-slate-200 bg-white p-8">
                <div className="h-10 w-10 animate-spin rounded-full border-2 border-slate-200 border-t-infinity-primary"></div>
              </div>
            ) : transactionsError ? (
              <div className="flex w-full items-center justify-center rounded-xl border border-red-200 bg-red-50 p-8 text-red-800">
                <span>{transactionsError}</span>
              </div>
            ) : (
              <TransactionsList depositList={depositList} purchaseList={purchaseList} />
            )
          ) : (
            <>
              <WalletBalance key={balanceRefreshKey} />
              <IncreaseBalance
                options={topupOptions}
                loading={optionsLoading}
                onTopupStarted={setTrackedTopup}
              />
            </>
          )}
        </div>
      </StorefrontAccountShell>
    </UserContainer>
  );
}
