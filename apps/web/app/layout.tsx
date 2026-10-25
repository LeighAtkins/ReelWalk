// Fonts ship as npm packages, so builds never fetch them from a font CDN.
// Bodoni Moda is the display face (wordmark, headings, prices), its optical
// size axis keeping the hairlines fine; Archivo does body and UI, its width
// axis used only to narrow timecodes.
import "@fontsource-variable/bodoni-moda/opsz.css";
import "@fontsource-variable/archivo/wdth.css";
import "@fontsource-variable/noto-sans-jp/wght.css";
// The serif of the "elegant" reel text style, also shown on its style chip.
import "@fontsource-variable/cormorant-garamond/wght.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import { WheelScroll } from "@/components/wheel-scroll";
import { SITE_URL } from "@/lib/site";

const DESCRIPTION = "Turn the photos and clips on your phone into a vertical listing reel in minutes, with the music cut to the beat. Free to start, no card.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "ReelWalk",
  description: DESCRIPTION,
  // What a shared link or an ad preview shows (no image yet: the owner picks one).
  openGraph: { type: "website", siteName: "ReelWalk", title: "ReelWalk: listing reels, made between shoots", description: DESCRIPTION, url: "/" },
  twitter: { card: "summary", title: "ReelWalk: listing reels, made between shoots", description: DESCRIPTION },
  appleWebApp: { capable: true, title: "ReelWalk", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark",
  width: "device-width",
  initialScale: 1,
  // Lets the layout extend under the notch and home indicator; padding uses env(safe-area-inset-*).
  viewportFit: "cover",
  // Android's keyboard shortens the page instead of sliding the view over it,
  // so fixed panels and sheets stay above it rather than being dragged around.
  interactiveWidget: "resizes-content",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <WheelScroll />
      </body>
    </html>
  );
}
