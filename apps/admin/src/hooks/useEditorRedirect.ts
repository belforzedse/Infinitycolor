import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useCurrentUser } from "@/hooks/useCurrentUser";

/**
 * Hook to redirect editor role users away from restricted pages
 * @param redirectTo - The path to redirect to (default: "/blog")
 */
export const useEditorRedirect = (redirectTo: string = "/blog") => {
  const router = useRouter();
  const { roleName } = useCurrentUser();

  useEffect(() => {
    const normalizedRole = (roleName ?? "").toLowerCase().trim();
    if (normalizedRole === "editor") {
      router.replace(redirectTo);
    }
  }, [roleName, router, redirectTo]);
};
