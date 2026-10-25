import type { Metadata } from "next";
import Link from "next/link";
import { CopyButton } from "@/components/copy-button";
import { appUrl } from "@/lib/app-url";
import { SCOPE_LABELS, SCOPES } from "@/lib/mcp/scopes";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Connect Claude or ChatGPT · ReelWalk",
  description: "Add ReelWalk as a connector in Claude or ChatGPT with one link, then make and edit your reels by chatting.",
};

/**
 * Public help for the MCP connector (ADR 0077): the one link, how to add it in
 * Claude and ChatGPT, what the assistant can and cannot do, and how to cut it
 * off again.
 */
export default async function ConnectPage() {
  const url = `${await appUrl()}/mcp`;
  return (
    <article className="prose" data-testid="connect">
      <h1>Connect Claude or ChatGPT</h1>
      <p className="muted small">Edit your reels by chatting. One link, no keys to copy.</p>

      <p>
        ReelWalk speaks MCP, the standard way chat assistants use other apps. Add the link below as a connector, sign in to ReelWalk once,
        and the assistant can find your reels, build a cut from your footage or free stock clips, change it, export it, and look at the
        result before you do.
      </p>

      <p>
        <code data-testid="connect-url">{url}</code>
      </p>
      <p>
        <CopyButton text={url} label="Copy the link" testId="copy-connect-url" />
      </p>

      <h2>In Claude</h2>
      <ol>
        <li>Open <strong>Settings → Connectors</strong>.</li>
        <li>Choose <strong>Add custom connector</strong>, name it ReelWalk and paste the link.</li>
        <li>Press <strong>Connect</strong>. ReelWalk opens: sign in, read what it asks for, untick anything you do not want to give, and press <strong>Allow</strong>.</li>
        <li>Start a chat and turn the ReelWalk connector on. Try: <em>&ldquo;List my reels and open the newest.&rdquo;</em></li>
      </ol>

      <h2>In ChatGPT</h2>
      <ol>
        <li>Open <strong>Settings → Connectors → Advanced</strong> and turn on <strong>Developer mode</strong> (custom connectors need it, and a plan that offers it).</li>
        <li>Choose <strong>Create</strong>, name it ReelWalk, paste the link and pick <strong>OAuth</strong> if it asks how to sign in.</li>
        <li>Allow ReelWalk when the sign-in page opens, then pick the connector in a new chat.</li>
      </ol>
      <p className="muted small">
        Menu names move around between app versions. If you cannot find them, search the app&apos;s help for &ldquo;custom connector&rdquo;.
      </p>

      <h2>What it can do</h2>
      <p>You choose which of these to allow on the sign-in page:</p>
      <ul>
        {SCOPES.map((scope) => (
          <li key={scope}>
            <strong>{SCOPE_LABELS[scope].title}.</strong> {SCOPE_LABELS[scope].detail}
          </li>
        ))}
      </ul>
      <p>
        It <strong>never posts to Instagram and never schedules a post</strong>; that stays in the app. AI shots use your own credits, and
        the assistant has to quote the cost and be told to go ahead before anything is spent. Every change it makes is saved as a new
        revision of the reel, so it shows up in the editor like any save.
      </p>

      <h2>House style</h2>
      <p>
        The connector tells the assistant how ReelWalk reels should look: no boxed text, no whoosh sounds, something moving inside the first
        second, a title from the first frame and kept clear of the middle of the picture. Tell it otherwise in the chat if you want a
        different look.
      </p>

      <h2>Cutting it off</h2>
      <p>
        Open <Link href="/account#apps">Account → Connected apps</Link> and press <strong>Disconnect</strong>. The assistant loses access at
        once. Access also expires on its own if you stop using the connector for 30 days.
      </p>
    </article>
  );
}
