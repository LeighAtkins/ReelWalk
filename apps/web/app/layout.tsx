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
import { COUNTRY_SNIPPET } from "@/lib/currency";
import { OG_IMAGE, SITE_URL } from "@/lib/site";

const DESCRIPTION = "Your listing, as a reel, in a minute. Turn the photos and clips on your phone into a vertical listing reel for Instagram, with the music cut to the beat. Free to start, no card.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "ReelWalk",
  description: DESCRIPTION,
  // What a shared link or an ad preview shows: the 1200x630 image of a phone playing a reel (ADR 0081).
  openGraph: { type: "website", siteName: "ReelWalk", locale: "en_AU", title: "ReelWalk: listing reels, made between shoots", description: DESCRIPTION, url: "/", images: [OG_IMAGE] },
  twitter: { card: "summary_large_image", title: "ReelWalk: listing reels, made between shoots", description: DESCRIPTION, images: [OG_IMAGE] },
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
    <html lang="en-AU">
      <body>
        {/* Places the visitor once (rw_country) so the server can price every later page in A$ or US$ (ADR 0085). */}
        <script dangerouslySetInnerHTML={{ __html: COUNTRY_SNIPPET }} />
        {children}
        <WheelScroll />
      </body>
    </html>
  );
}
