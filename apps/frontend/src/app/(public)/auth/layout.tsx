import Image from "next/image";
import { Suspense } from "react";
import AuthIllustration from "@/components/Auth/Illustration";
import SuspenseLoader from "@/components/ui/SuspenseLoader";
import { StorefrontContainer } from "@/components/storefront/StorefrontContainer";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-start justify-center bg-infinity-primary-lighter/20 p-4 md:items-center">
      <StorefrontContainer className="flex flex-col items-center justify-center gap-8 py-8 md:flex-row md:py-0">
        <div className="card w-full max-w-[630px] rounded-panel p-2">
          <div className="relative mx-auto max-w-[516px] px-2 py-4 md:py-6">
            <div className="mb-[4px] flex flex-col items-center gap-4 md:mb-[20px] md:gap-5">
              <div className="relative h-[56px] w-[90px] md:h-[68px] md:w-[110px]">
                <Image src="/images/logo_PDF.webp" alt="Logo" fill className="object-contain" />
              </div>
            </div>
            <Suspense fallback={<SuspenseLoader />}>{children}</Suspense>
          </div>
        </div>
        <div className="block w-full max-w-[350px] md:max-w-[651px]">
          <AuthIllustration />
        </div>
      </StorefrontContainer>
    </main>
  );
}
