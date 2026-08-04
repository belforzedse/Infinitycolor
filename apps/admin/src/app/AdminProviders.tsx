"use client";

import type { ReactNode } from "react";
import { Provider } from "jotai";
import { NuqsAdapter } from "nuqs/adapters/next";
import { Toaster } from "react-hot-toast";
import jotaiStore from "@/lib/jotaiStore";
import AdminServiceWorker from "@/components/AdminServiceWorker";
import AdminAnalytics from "@/components/AdminAnalytics";

export default function AdminProviders({ children }: { children: ReactNode }) {
  return (
    <Provider store={jotaiStore}>
      <NuqsAdapter>
        {children}
        <AdminServiceWorker />
        <AdminAnalytics />
        <Toaster
          position="bottom-center"
          containerStyle={{ zIndex: 2147483647 }}
          toastOptions={{ style: { zIndex: 2147483647 } }}
        />
      </NuqsAdapter>
    </Provider>
  );
}
