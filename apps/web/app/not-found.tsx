import Link from "next/link";

export default function NotFound() {
  return (
    <header className="page-head">
      <h1>Nothing at this address</h1>
      <p>The property may have been removed, or the link is incomplete.</p>
      <Link href="/" className="button" style={{ justifySelf: "start" }}>
        See all properties
      </Link>
    </header>
  );
}
