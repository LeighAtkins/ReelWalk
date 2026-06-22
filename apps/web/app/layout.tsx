import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "ReelWalk",
  description: "Task 01 upload to stub render slice",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
