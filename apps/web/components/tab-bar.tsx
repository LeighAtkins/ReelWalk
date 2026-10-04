"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ExportsIcon, ReelsIcon } from "./icons";

const TABS = [
  { href: "/", label: "Reels", Icon: ReelsIcon, match: (path: string) => path === "/" },
  { href: "/exports", label: "Exports", Icon: ExportsIcon, match: (path: string) => path.startsWith("/exports") },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ href, label, Icon, match }) => (
        <Link key={href} href={href} className="tab" aria-current={match(pathname) ? "page" : undefined}>
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  );
}
