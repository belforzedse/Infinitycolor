# توسعهٔ محلی در لینوکس و ویندوز

[نسخهٔ انگلیسی](development.md)

## ابزارها

Node.js نسخهٔ 20.19 یا جدیدتر از سری 20.x (در بازهٔ نسخه‌های پشتیبانی‌شدهٔ بک‌اند)، Git و Docker Compose را نصب کنید. در ویندوز از PowerShell و Docker Desktop با WSL2 استفاده کنید. در WSL2 هم می‌توانید دستورهای لینوکس را اجرا کنید؛ مخزن و `node_modules` را در فایل‌سیستم یک سیستم‌عامل نگه دارید و هنگام جابه‌جایی بین سیستم‌عامل‌ها وابستگی‌ها را دوباره نصب کنید.

نسخهٔ موردنیاز pnpm در فیلد `packageManager` فایل `package.json` ریشه آمده است: **pnpm 10.28.2**. npm فقط برای نصب Corepack در صورت نبودن آن به‌کار می‌رود؛ در فضای کاری، دستور `npm install` اجرا نکنید و فایل lock دومی نسازید.

```bash
npm install --global corepack
corepack pnpm --version
```

این دستورها در PowerShell هم کار می‌کنند. اجرای `corepack enable pnpm` اختیاری است؛ اگر ویندوز اجازهٔ نوشتن shim کنار Node را نداد، مستقیماً از `corepack pnpm` استفاده کنید.

## دریافت مخزن و نصب

طبق [راهنمای GitLab](gitlab-workflow.fa.md) احراز هویت کنید، سپس در Bash یا PowerShell اجرا کنید:

```bash
glab repo clone bel4/infinity
cd infinity
corepack pnpm install --frozen-lockfile
node scripts/setup-dev-env.mjs
```

ابزار راه‌اندازی، فایل‌های تنظیمات محلی را که هنوز ساخته نشده‌اند، از روی نمونه‌های موجود در مخزن می‌سازد، کلیدهای محرمانهٔ تازه تولید می‌کند و فایل‌های موجود را بدون تغییر نگه می‌دارد. فقط مسیرها را چاپ می‌کند و مقدار کلیدهای محرمانه را نشان نمی‌دهد. برای دیدن این‌که کدام فایل‌ها هنوز ساخته نشده‌اند:

```bash
node scripts/setup-dev-env.mjs --check
```

این ابزار `apps/backend/.env` و فایل‌های `.env.local` برنامه‌های وب را می‌سازد. کلیدهای محرمانهٔ لازم برای Strapi و رمز عبور پایگاه داده در محیط محلی ساخته می‌شوند. اطلاعات ورود سرویس‌های جانبی را فقط در صورت نیاز وارد کنید؛ نیازی به فایل تنظیمات محیط عملیاتی نیست.

```bash
docker compose --env-file apps/backend/.env -f compose.dev.yml up -d
```

این فایل Compose فقط سرویس‌های پایگاه داده و حافظهٔ نهان محلی پروژه را اجرا می‌کند؛ ایمیج‌های برنامه را اجرا نمی‌کند و استقراری انجام نمی‌دهد.

نمونه‌های Auth اتصال migration را از role برنامه جدا می‌کنند. در پایگاه دادهٔ محلی تازه، پیش از اجرای Auth، schema افزایشی Auth را آماده کنید:

```bash
node --env-file=apps/auth/.env.local apps/auth/scripts/apply-migration.mjs
```

این دستور فقط از URL migration محلیِ تولیدشده استفاده می‌کند. اسکریپت migration موجود، pathname مربوط به URL را به‌عنوان مسیر فایل‌سیستم به‌کار می‌برد؛ اگر مسیر درایو ویندوز پذیرفته نشد، این مرحله را در Windows از WSL2 اجرا کنید. کل محیط محلی می‌تواند در WSL2 اجرا شود، بدون این‌که وابستگی‌های ویندوز و لینوکس مخلوط شوند.

`AUTH_STRAPI_BRIDGE_SECRET` مشترک در بک‌اند و Auth باید یکسان باشد. [معماری auth](auth/architecture.md) و [راهنمای عملیات](auth/operations.md) را ببینید. فایل Compose توسعه یک Redis جداگانه با سیاست noeviction برای BullMQ هم دارد.

## اجرا

در ترمینال اول بک‌اند را اجرا کنید:

```bash
corepack pnpm --filter @repo/backend dev
```

وقتی Strapi آماده شد، در ریشهٔ مخزن و ترمینال دوم اجرا کنید:

```bash
corepack pnpm --filter @repo/frontend dev
```

حساب مدیر فنی محلی Strapi را در `/admin` بسازید؛ پیش از انتظار برای نمایش کامل فروشگاه، دسترسی‌های محتوای محلی را تنظیم کنید. جریان‌های پرداخت و SMS وابسته به ارائه‌دهنده فقط زمانی کار می‌کنند که توکن‌ها و کلیدهای توسعهٔ مربوط را خودتان تنظیم کرده باشید.

برای Auth، پنل مدیریت اختصاصی و محتوای social، پس از اجرای migration احراز هویت، هرکدام را در ترمینال جداگانه اجرا کنید:

```bash
corepack pnpm --filter @repo/auth dev
corepack pnpm --filter @repo/admin dev
corepack pnpm --filter @repo/social dev
```

| برنامه | نشانی محلی |
| --- | --- |
| فروشگاه | http://localhost:2888 |
| Strapi | http://localhost:1337/admin |
| احراز هویت | http://localhost:2889 |
| پنل مدیریت اختصاصی | http://localhost:2891 |
| شبکهٔ اجتماعی | http://localhost:2890 |

## بررسی‌ها

```bash
corepack pnpm lint
corepack pnpm check-types
corepack pnpm test
corepack pnpm build
```

هنگام توسعه، packageهای متأثر را بررسی کنید و پیش از merge، بررسی‌های گستردهٔ مرتبط را اجرا کنید. پس از به‌روزرسانی وابستگی‌ها، lockfile مربوط به pnpm را با نسخهٔ تعیین‌شده به‌روز کنید و مطمئن شوید که نصب در یک clone تازه هم موفق می‌شود.

## توقف و عیب‌یابی

فرایندهای برنامه را با Ctrl+C متوقف کنید. برای متوقف‌کردن سرویس‌های محلی، `docker compose --env-file apps/backend/.env -f compose.dev.yml down` را اجرا کنید.

volumeهای پایگاه داده را نگه دارید، مگر این‌که عمداً بخواهید داده‌های محلی را پاک کنید.

اگر پورتی اشغال است، پیش از متوقف‌کردن فرایند، مشخص کنید متعلق به کدام پروژه است. خطای نصب با در دسترس نبودن سرویس محلی فرق دارد: ابتدا نسخه‌های Node و pnpm، سپس سلامت Compose و URL پیکربندی‌شدهٔ برنامه را بررسی کنید. فایل‌های پیکربندی با کدگذاری UTF-8 و قالب `KEY=value` هستند؛ نحو متغیر PowerShell را در فایل `.env` وارد نکنید. توکن‌ها و کلیدهای خصوصی را در مقدارهای `NEXT_PUBLIC_*` قرار ندهید.
