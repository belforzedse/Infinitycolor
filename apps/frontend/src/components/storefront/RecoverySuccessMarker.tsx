"use client";
import { useEffect } from "react";
import { completeStorefrontRecovery } from "@/lib/storefront-recovery";

export default function RecoverySuccessMarker() {
  useEffect(() => completeStorefrontRecovery(), []);
  return null;
}
