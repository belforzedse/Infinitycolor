import { Suspense } from "react";
import { AuthIllustration } from "@repo/auth-ui";
import authLogo from "../../../../frontend/public/images/logo_PDF.webp";
import { AuthFlowProvider } from "@/components/auth/auth-flow-context";
import { getAuthEnv } from "@/server/env";

export const dynamic = "force-dynamic";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const storefrontOrigin = getAuthEnv().defaultStorefrontOrigin;
  return (
    <main className="flex min-h-screen items-start justify-center bg-infinity-primary-lighter/20 p-4 md:items-center">
      <div className="mx-auto flex w-full max-w-[1320px] flex-col items-center justify-center gap-8 md:flex-row">
        <div className="card w-full max-w-[630px] p-2">
          <div className="relative mx-auto max-w-[516px] px-2 py-4 md:py-6">
            <div className="mb-1 flex flex-col items-center gap-4 md:mb-5 md:gap-5">
              <img
                src={authLogo.src}
                width="110"
                height="68"
                alt="اینفینیتی کالر"
                className="h-[56px] w-[90px] object-contain md:h-[68px] md:w-[110px]"
              />
            </div>
            <Suspense
              fallback={
                <div className="p-8 text-center">در حال بارگذاری...</div>
              }
            >
              <AuthFlowProvider>
                <div data-storefront-origin={storefrontOrigin}>{children}</div>
              </AuthFlowProvider>
            </Suspense>
          </div>
        </div>
        <div className="block w-full max-w-[350px] md:max-w-[651px]">
          <AuthIllustration />
        </div>
      </div>
    </main>
  );
}
