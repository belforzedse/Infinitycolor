import { cn } from "@/lib/utils";
import type { MouseEventHandler, ReactNode } from "react";

type CheckoutLinkProps = {
  children: ReactNode;
  className?: string;
  onClick?: MouseEventHandler<HTMLAnchorElement>;
  testId?: string;
};

/**
 * Native checkout link. Next.js `<Link>` calls preventDefault and then the
 * app router, which older mobile WebViews can drop after a touch. A real href
 * still navigates if client routing does not run.
 */
export default function CheckoutLink({
  children,
  className,
  onClick,
  testId = "cart-checkout-link",
}: CheckoutLinkProps) {
  return (
    <a href="/checkout" data-testid={testId} className={cn("touch-manipulation", className)} onClick={onClick}>
      {children}
    </a>
  );
}
