import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { ProfileSidebar } from "@/components/profile/ProfileSidebar";
import { SocialContainer } from "@/components/SocialContainer";
import { connection } from "next/server";

// TODO: Cache Components adoption. Refactor this route so this opt-out can be removed.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function ProfileLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  await connection();
  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <SocialContainer as="main" className="flex-1 pb-6 pt-6 lg:pb-12">
        <div className="flex min-w-0 flex-col gap-6 lg:flex-row lg:gap-8">
          <ProfileSidebar />
          <div className="min-w-0 flex-1">{children}</div>
        </div>
      </SocialContainer>
    </div>
  );
}
