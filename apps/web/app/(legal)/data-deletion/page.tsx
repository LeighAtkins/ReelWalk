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
        Open <a href="/account#delete">Account</a>, enter your password under <strong>Delete account</strong> and confirm. Your account,
        studio, media, reels, renders and any connected-account tokens are deleted at once, from the database and from storage.
      </p>
      <p>
        If you can no longer sign in, email{" "}
        <a href="mailto:leigh.atkins1@gmail.com?subject=Delete%20my%20ReelWalk%20account">leigh.atkins1@gmail.com</a> from the address you
        signed up with, and it is done within 7 days.
      </p>
    </article>
  );
}
