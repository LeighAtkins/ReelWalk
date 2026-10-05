import type { Metadata, Viewport } from "next";
import "@fontsource-variable/archivo/wdth.css";
import "./globals.css";
import { SettingsEffect } from "@/lib/settings";
import { TabBar, TopBar } from "@/components/Chrome";

const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "ReelWalk 面接ノート",
  description: "Study the ReelWalk stack and explain it in Japanese.",
  manifest: `${base}/manifest.webmanifest`,
  icons: { icon: `${base}/icon.svg`, apple: `${base}/icon-180.png` },
  appleWebApp: { capable: true, title: "面接ノート", statusBarStyle: "default" },
};

export const viewport: Viewport = {
  themeColor: "#F2F4F6",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-furigana="on" data-english="show">
      <body>
        <SettingsEffect />
        <TopBar />
        <main className="page">{children}</main>
        <TabBar />
      </body>
    </html>
  );
}
