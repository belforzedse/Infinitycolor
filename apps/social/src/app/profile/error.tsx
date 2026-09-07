"use client";

export default function ProfileError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-4 p-6 text-center" role="alert">
      <p className="text-neutral-700">بارگذاری این صفحه ناموفق بود. دوباره تلاش کنید.</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-xl bg-infinity-primary px-5 py-2 text-sm text-white"
      >
        تلاش دوباره
      </button>
    </div>
  );
}
