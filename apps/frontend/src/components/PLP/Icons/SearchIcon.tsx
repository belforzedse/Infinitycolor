import type { SVGProps } from "react";
import { Search } from "lucide-react";

export default function SearchIcon(props: SVGProps<SVGSVGElement>) {
  return <Search size={24} strokeWidth={1.5} aria-hidden {...props} />;
}
