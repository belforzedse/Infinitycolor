"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function OldCustomizationRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/customization");
  }, [router]);

  return null;
}
