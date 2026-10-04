// Fonts ship as npm packages, so builds never fetch them from a font CDN.
// Archivo's width axis carries the type: wide for headings, narrow for timecodes.
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/noto-sans-jp/wght.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "ReelWalk",
  description: "Edit Instagram Reels for your listings, on your phone.",
  appleWebApp: { capable: true, title: "ReelWalk", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0f2a44",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Lets the layout extend under the notch and home indicator; padding uses env(safe-area-inset-*).
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
