"use client";

import React, { createContext, Suspense, useCallback, useContext, useState } from "react";
import MobileMenu from "@/components/PLP/Header/Mobile/MobileMenu";

type OpenMobileMenuOptions = {
  focusSearch?: boolean;
};

type MobileMenuContextType = {
  isOpen: boolean;
  openMenu: (options?: OpenMobileMenuOptions) => void;
  closeMenu: () => void;
};

const MobileMenuContext = createContext<MobileMenuContextType | null>(null);

export function MobileMenuProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusSearchOnOpen, setFocusSearchOnOpen] = useState(false);

  const openMenu = useCallback((options?: OpenMobileMenuOptions) => {
    setFocusSearchOnOpen(options?.focusSearch ?? false);
    setIsOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setIsOpen(false);
    setFocusSearchOnOpen(false);
  }, []);

  return (
    <MobileMenuContext.Provider value={{ isOpen, openMenu, closeMenu }}>
      {children}
      {/* MobileMenu reads useSearchParams(); without this boundary Next cannot
          statically prerender routes that only use the root layout (/categories). */}
      <Suspense fallback={null}>
        <MobileMenu
          isOpen={isOpen}
          onClose={closeMenu}
          focusSearchOnOpen={focusSearchOnOpen}
        />
      </Suspense>
    </MobileMenuContext.Provider>
  );
}

export function useMobileMenu(): MobileMenuContextType {
  const context = useContext(MobileMenuContext);
  if (!context) {
    throw new Error("useMobileMenu must be used within a MobileMenuProvider");
  }
  return context;
}
