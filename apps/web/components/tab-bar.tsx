"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountIcon, ExportsIcon, FeedbackIcon, ReelsIcon } from "./icons";

const TABS = [
  { href: "/", label: "Reels", Icon: ReelsIcon, match: (path: string) => path === "/" },
  { href: "/exports", label: "Exports", Icon: ExportsIcon, match: (path: string) => path.startsWith("/exports") },
  { href: "/account", label: "Account", Icon: AccountIcon, match: (path: string) => path.startsWith("/account") },
  // Carries the screen the person was on, so the note says where it came from.
  { href: "/feedback", label: "Feedback", Icon: FeedbackIcon, match: (path: string) => path.startsWith("/feedback") },
];

export function TabBar() {
  const pathname = usePathname();
  return (
    <nav className="tabbar" aria-label="Main">
      {TABS.map(({ href, label, Icon, match }) => (
        <Link
          key={href}
          href={href === "/feedback" && !match(pathname) ? `/feedback?from=${encodeURIComponent(pathname)}` : href}
          className="tab"
          aria-current={match(pathname) ? "page" : undefined}
          prefetch={href === "/feedback" ? false : undefined}
        >
          <Icon />
          {label}
        </Link>
      ))}
    </nav>
  );
}
