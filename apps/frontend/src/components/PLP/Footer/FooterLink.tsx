import Link from "next/link";

interface FooterLinkProps {
  href: string;
  children: React.ReactNode;
}

const FooterLink = ({ href, children }: FooterLinkProps) => {
  return (
    <Link
      href={href}
      prefetch={false}
      className="group flex min-w-0 items-center justify-start gap-1 text-sm text-neutral-600 transition-colors hover:text-infinity-primary md:justify-end"
    >
      <span className="h-1 w-1 shrink-0 rounded-full bg-neutral-300 group-hover:bg-infinity-primary" />
      <span className="min-w-0">{children}</span>
    </Link>
  );
};

export default FooterLink;
