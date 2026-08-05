export default function OfflinePage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-50 p-6" dir="rtl">
      <section className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm" role="alert">
        <h1 className="text-xl font-semibold text-slate-900">اتصال برقرار نیست</h1>
        <p className="mt-3 text-sm leading-7 text-slate-600">
          برای حفظ امنیت، اطلاعات پنل مدیریت به‌صورت آفلاین ذخیره نمی‌شود. اتصال اینترنت را بررسی و دوباره تلاش کنید.
        </p>
        <a className="mt-5 inline-block rounded-lg bg-infinity-primary px-4 py-2 text-white" href="/">
          تلاش دوباره
        </a>
      </section>
    </main>
  );
}
