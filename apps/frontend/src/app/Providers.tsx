"use client";

import type { ReactNode } from "react";
import { Provider } from "jotai";
import jotaiStore from "@/lib/jotaiStore";
import TopProgressBar from "@/components/ui/TopProgressBar";
import PreloadBlur from "@/components/ui/PreloadBlur";
import GlobalFetchInterceptor from "@/components/ui/GlobalFetchInterceptor";
import GlobalLoadingOverlay from "@/components/ui/GlobalLoadingOverlay";
import GlobalErrorDisplay from "@/components/ui/GlobalErrorDisplay";
import ImageEffects from "@/components/ui/ImageEffects";
import ServiceWorkerRegistration from "@/components/ui/ServiceWorkerRegistration";
import AuthInitializer from "@/components/ui/AuthInitializer";
import AppReadyMarker from "@/components/ui/AppReadyMarker";
import { Suspense } from "react";
import { useFreshDataOnVisibility } from "@/hooks/useFreshDataOnVisibility";
import { AnalyticsTracker } from "@/components/Analytics/AnalyticsTracker";
import PWAInstallPrompt from "@/components/ui/PWAInstallPrompt";
import { SharedElementTransitionProvider } from "@/contexts/SharedElementTransitionContext";
import NetworkStatusBanner from "@/components/ui/NetworkStatusBanner";
import VersionCheck from "@/components/ui/VersionCheck";
import IssueReportWidget from "@/components/IssueReport/IssueReportWidget";
import ModelHiringModal from "@/components/ModelHiring/ModelHiringModal";

export default function Providers({ children }: { children: ReactNode }) {
  // Enable automatic data refresh on all pages when tab becomes visible (10 min debounce)
  useFreshDataOnVisibility();
  return (
    <Provider store={jotaiStore}>
      <SharedElementTransitionProvider>
        <Suspense fallback={null}>
          <AnalyticsTracker />
        </Suspense>
        {/*
         * Global UI helpers are registered here so that pages throughout the app
         * can rely on shared behavior without needing to include these components
         * individually. The order of these components generally reflects the
         * desired rendering priority for visual elements.
         */}
        <AuthInitializer />
        <ServiceWorkerRegistration />
        <PreloadBlur />
        <TopProgressBar />
        {/* Intercepts fetch calls to show global error/loading states */}
        <GlobalFetchInterceptor />
        {/* Displays friendly error notifications for 401/403/etc */}
        <GlobalErrorDisplay />
        <ImageEffects />
        {children}
        <GlobalLoadingOverlay />
        <NetworkStatusBanner />
        <VersionCheck />
        <PWAInstallPrompt />
        <IssueReportWidget />
        <ModelHiringModal />
        {/* Last, so its effect runs after the page content has hydrated. */}
        <AppReadyMarker />
      </SharedElementTransitionProvider>
    </Provider>
  );
}
