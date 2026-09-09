"use client";

import type { ReactNode } from "react";
import { useSetAtom } from "jotai";

import { modelHiringModalOpenAtom } from "@/atoms/modelHiring";
import type { FooterLink as FooterLinkType } from "@/constants/footer";
import { requestCartScrollTop } from "@/utils/cartScrollIntent";
import Link from "next/link";

const itemClassName =
  "group flex min-w-0 items-center justify-start gap-1 text-sm text-neutral-600 transition-colors hover:text-infinity-primary md:justify-end";

function FooterItemMark({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="h-1 w-1 shrink-0 rounded-full bg-neutral-300 group-hover:bg-infinity-primary" />
      <span className="min-w-0">{children}</span>
    </>
  );
}

interface FooterLinkProps {
  href?: string;
  onClick?: () => void;
  children: ReactNode;
}

const FooterLink = ({ href, onClick, children }: FooterLinkProps) => {
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={itemClassName}>
        <FooterItemMark>{children}</FooterItemMark>
      </button>
    );
  }

  if (!href) {
    return null;
  }

  return (
    <Link
      href={href}
      onNavigate={href === "/cart" ? requestCartScrollTop : undefined}
      prefetch={false}
      className={itemClassName}
    >
      <FooterItemMark>{children}</FooterItemMark>
    </Link>
  );
};

export function FooterNavItem({ link }: { link: FooterLinkType }) {
  const openHiringModal = useSetAtom(modelHiringModalOpenAtom);

  if ("action" in link) {
    return (
      <FooterLink onClick={() => openHiringModal(true)}>{link.title}</FooterLink>
    );
  }

  return <FooterLink href={link.url}>{link.title}</FooterLink>;
}

export default FooterLink;
