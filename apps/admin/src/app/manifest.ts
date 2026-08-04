import type { MetadataRoute } from "next";
import { adminEnvironment } from "@/config/admin-env";

export default function manifest(): MetadataRoute.Manifest {
  const staging = adminEnvironment() === "staging";
  const iconPrefix = staging ? "admin-staging" : "admin";
  return {
    id: staging ? "/infinity-admin-staging" : "/infinity-admin",
    name: staging ? "مدیریت اینفینیتی - آزمایشی" : "مدیریت اینفینیتی",
    short_name: staging ? "مدیریت آزمایشی" : "مدیریت اینفینیتی",
    description: "سامانه مستقل و امن مدیریت اینفینیتی",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: staging ? "#fff7ed" : "#f9fafb",
    theme_color: staging ? "#c2410c" : "#3d4c6e",
    dir: "rtl",
    lang: "fa",
    orientation: "any",
    icons: [
      { src: `/icons/${iconPrefix}-192.png`, sizes: "192x192", type: "image/png", purpose: "any" },
      { src: `/icons/${iconPrefix}-512.png`, sizes: "512x512", type: "image/png", purpose: "any" },
      { src: `/icons/${iconPrefix}-maskable-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
