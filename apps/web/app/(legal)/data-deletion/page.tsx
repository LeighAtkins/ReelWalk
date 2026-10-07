import type { Metadata } from "next";

export const metadata: Metadata = { title: "Data deletion · ReelWalk" };

export default function DataDeletionPage() {
  return (
    <article className="prose">
      <h1>Deleting your data</h1>

      <h2>Instagram connection</h2>
      <p>
        Open <a href="/account">Account</a> and tap <strong>Disconnect</strong> under Instagram. The stored access token, account id and
        username are deleted immediately. You can also remove ReelWalk from your Facebook or Instagram settings under Apps and websites,
        which revokes the token on Meta&apos;s side.
      </p>

      <h2>Reels and media</h2>
      <p>Delete any reel from its editor. Share links stop working the moment you turn them off.</p>

      <h2>Your whole account</h2>
      <p>
        Email <a href="mailto:leigh.atkins1@gmail.com?subject=Delete%20my%20ReelWalk%20account">leigh.atkins1@gmail.com</a> from the
        address you signed up with. Your account, studio, media, reels, renders and any connected-account tokens are deleted within 7
        days, and you get a confirmation when it is done.
      </p>
    </article>
  );
}
