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

export const metadata: Metadata = {
  title: "ReelWalk",
  description: "Edit Instagram Reels for your listings, on your phone.",
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
