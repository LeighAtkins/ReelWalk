import type { Metadata } from "next";

export const metadata: Metadata = { title: "Terms · ReelWalk" };

export default function TermsPage() {
  return (
    <article className="prose">
      <h1>Terms of service</h1>
      <p className="muted small">Last updated 7 October 2026</p>

      <h2>The service</h2>
      <p>
        ReelWalk lets you edit and render short vertical videos from media you provide, and optionally publish them to an Instagram
        account you control. It is offered as is, while in active development, and may change or pause without notice.
      </p>

      <h2>Your content</h2>
      <p>
        You keep all rights to what you upload and make. You confirm you have the right to use the photos, videos, music and text you put
        in a reel, and that posting them to Instagram complies with Instagram&apos;s rules. Included library media is openly licensed; the
        licence and credit are shown with each item and, where a credit is required, added to the caption.
      </p>

      <h2>Acceptable use</h2>
      <p>
        Do not use ReelWalk to make content that is unlawful, infringing, deceptive, or that discriminates in housing advertising. Do not
        attempt to access other studios&apos; content or to disrupt the service.
      </p>

      <h2>Accounts</h2>
      <p>You are responsible for keeping your password private. We may suspend accounts that break these terms.</p>

      <h2>Liability</h2>
      <p>
        The service is provided without warranty. To the extent the law allows, the operator is not liable for lost content, lost
        posts, or indirect damages. Keep copies of anything you cannot afford to lose.
      </p>

      <h2>Contact</h2>
      <p>
        <a href="mailto:leigh.atkins1@gmail.com">leigh.atkins1@gmail.com</a>
      </p>
    </article>
  );
}
