"use client";

import dynamic from "next/dynamic";

const DebugPanel = dynamic(() => import("./DebugPanel"), {
  ssr: false,
});

export default function DevOnlyDebugPanel() {
  if (process.env.NODE_ENV !== "development") return null;

  return <DebugPanel />;
}
