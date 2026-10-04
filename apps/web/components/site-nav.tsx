"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export function SiteNav() {
  const pathname = usePathname();
  const onProperties = pathname === "/" || pathname.startsWith("/properties");
  const onRenders = pathname.startsWith("/renders");

  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" aria-current={onProperties ? "page" : undefined}>
        Properties
      </Link>
      <Link href="/renders" aria-current={onRenders ? "page" : undefined}>
        Renders
      </Link>
      {/* A separate app behind nginx, so a plain anchor rather than a client-side route. */}
      <a href="/editor/">Editor</a>
    </nav>
  );
}
