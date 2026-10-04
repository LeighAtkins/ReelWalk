// The font ships as an npm package, so builds never fetch it from a font CDN.
// wdth.css includes the width axis: headlines use the condensed end of it.
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "@/components/icons";
import { SiteNav } from "@/components/site-nav";

export const metadata: Metadata = {
  title: "ReelWalk",
  description: "Turn property media into shareable vertical reels",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">
            <BrandMark />
            ReelWalk
          </Link>
          <SiteNav />
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
