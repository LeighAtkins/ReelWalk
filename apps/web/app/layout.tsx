import "./globals.css";
import type { Metadata } from "next";
import Link from "next/link";

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
            ReelWalk
          </Link>
          <nav>
            <Link href="/">Properties</Link>
            <Link href="/renders">Renders</Link>
            <a href="/editor/">Editor</a>
          </nav>
        </header>
        <main className="page">{children}</main>
      </body>
    </html>
  );
}
