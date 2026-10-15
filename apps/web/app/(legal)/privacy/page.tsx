import type { Metadata } from "next";

export const metadata: Metadata = { title: "Privacy · ReelWalk" };

export default function PrivacyPage() {
  return (
    <article className="prose">
      <h1>Privacy policy</h1>
      <p className="muted small">Last updated 15 October 2026</p>

      <h2>What ReelWalk is</h2>
      <p>
        ReelWalk is a small studio tool for making short vertical videos (Instagram Reels) from your own photos, videos and music. It is
        operated by Leigh Atkins. This page explains what the service stores and why.
      </p>

      <h2>What we store</h2>
      <ul>
        <li>
          <strong>Account</strong>: your name, email address and a salted hash of your password. Sessions are kept in our database so you
          can stay signed in; a session cookie holds a random token only.
        </li>
        <li>
          <strong>Your media and reels</strong>: the photos, videos and songs you upload, the edits you make, the captions you write and the
          videos we render for you. They are stored in object storage and belong to your studio; other studios cannot see them.
        </li>
        <li>
          <strong>Share links</strong>: if you turn on a share link, anyone holding that link can watch the exported video and read its
          caption until you turn the link off.
        </li>
        <li>
          <strong>Instagram connection</strong> (optional): if you connect an Instagram professional account, we store the account id, its
          username and the access token Meta issues, so that you can publish exports as Reels. We use it for nothing else. Disconnecting
          deletes the token.
        </li>
        <li>
          <strong>Comment replies</strong> (optional): if you turn on comment replies, we also store a second access token from
          Instagram&apos;s own login. With it we read the comments on your most recent posts and, when a comment contains one of your
          keywords, send that person the one direct message you wrote, and your public reply if you set one. We keep the comment&apos;s id,
          the commenter&apos;s username and the comment text, so nobody is answered twice and you can see what was sent. The same connection reads
          your posted reels&apos; views, reach and watch time to show them on your Scheduled page. We do not read your other messages. Turning comment replies off deletes the token.
        </li>
        <li>
          <strong>Featured reels</strong> (optional): if you tick &quot;Feature my reel&quot; on an export, we may repost that video on our
          Instagram account and website, crediting the handle you give. We record when you ticked it. Untick the box and we stop using the
          reel from then on.
        </li>
        <li>
          <strong>Email</strong>: we email you only to reset your password when you ask, and to answer feedback you send us if you let
          us. Feedback is kept with your email address and the screen it was sent from.
        </li>
        <li>
          <strong>Server logs</strong>: ordinary request logs (addresses, paths, timestamps) kept briefly to run and debug the service.
        </li>
      </ul>

      <h2>What we do not do</h2>
      <p>We do not sell or share your data, run advertising, or use your content to train anything. We do not read your Instagram messages.</p>

      <h2>Third parties</h2>
      <p>
        Media and rendered videos are stored with Amazon Web Services. Stock footage search, if enabled, sends your search terms to
        Pixabay. Publishing to Instagram sends the video and caption you chose to Meta under Meta&apos;s own terms.
      </p>

      <h2>Your choices</h2>
      <p>
        You can change your name and password and disconnect Instagram from the Account page, delete any reel from its editor, and
        turn share links off at any time. To delete your account and everything in it, see <a href="/data-deletion">Data deletion</a>.
      </p>

      <h2>Contact</h2>
      <p>
        Questions: <a href="mailto:leigh.atkins1@gmail.com">leigh.atkins1@gmail.com</a>.
      </p>
    </article>
  );
}
