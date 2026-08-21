import { connection } from "next/server";
import AuthenticatedUserClientLayout from "./AuthenticatedUserClientLayout";

export const instant = false;

export default async function AuthenticatedUserLayout({ children }: { children: React.ReactNode }) {
  await connection();
  return <AuthenticatedUserClientLayout>{children}</AuthenticatedUserClientLayout>;
}
