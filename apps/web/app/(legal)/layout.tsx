import Link from "next/link";
import { BrandMark } from "@/components/icons";

/** Public pages: privacy, terms, data deletion. Linked from the Meta app settings. */
export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="legal">
      <header className="share-head">
        <Link href="/" className="brand">
          <BrandMark />
          ReelWalk
        </Link>
      </header>
      {children}
      <footer className="muted small" style={{ marginTop: 32 }}>
        <Link href="/privacy" className="link">
          Privacy
        </Link>
        {" · "}
        <Link href="/terms" className="link">
          Terms
        </Link>
        {" · "}
        <Link href="/data-deletion" className="link">
          Data deletion
        </Link>
        {" · "}
        <a href="mailto:leigh.atkins1@gmail.com" className="link">
          Contact
        </a>
      </footer>
    </main>
  );
}
