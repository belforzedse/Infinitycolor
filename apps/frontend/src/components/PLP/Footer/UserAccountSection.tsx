import { FooterNavItem } from "./FooterLink";
import type { FooterLink as FooterLinkType } from "@/constants/footer";

interface UserAccountSectionProps {
  header: string;
  links: FooterLinkType[];
}

const UserAccountSection = ({ header, links }: UserAccountSectionProps) => {
  return (
    <div className="flex flex-col gap-2 border-b border-slate-200 pb-5 md:h-full md:min-h-[324px] md:border-b-[0px] md:border-none md:px-4 lg:px-6">
      <h3 className="text-base text-neutral-900">{header}</h3>

      <div className="grid grid-cols-2 items-start gap-x-4 gap-y-2 md:flex md:flex-col">
        {links.map((link, index) => (
          <FooterNavItem key={index} link={link} />
        ))}
      </div>
    </div>
  );
};

export default UserAccountSection;
