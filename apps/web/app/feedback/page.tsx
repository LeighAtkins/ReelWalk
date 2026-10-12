import type { Metadata } from "next";
import Link from "next/link";
import { FeedbackForm } from "@/components/feedback-form";
import { BackIcon } from "@/components/icons";
import { TabBar } from "@/components/tab-bar";
import { SUPPORT_EMAIL } from "@/lib/email";
import { getCurrentUser } from "@/lib/workspace";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Feedback · ReelWalk" };

/** Opened from the Feedback tab; ?from= carries the screen the person was on. */
export default async function FeedbackPage({ searchParams }: { searchParams: Promise<{ from?: string; feedback?: string; message?: string }> }) {
  const { from, feedback, message } = await searchParams;
  await getCurrentUser();
  const page = from && from.startsWith("/") && !from.startsWith("//") ? from : null;
  const back = page ? `/feedback?from=${encodeURIComponent(page)}` : "/feedback";

  return (
    <>
      <main className="shell">
        <header className="shell-head">
          {page && page !== "/feedback" ? (
            <Link href={page} className="btn btn-quiet" prefetch={false}>
              <BackIcon size={18} />
              Back
            </Link>
          ) : (
            <span />
          )}
        </header>
        <h1 style={{ marginBottom: 16 }}>Feedback</h1>
        <FeedbackForm page={page} back={back} status={feedback} error={message} heading="Tell us what you think" />
        <p className="muted small" style={{ marginTop: 16 }}>
          Prefer email?{" "}
          <a className="link" href={`mailto:${SUPPORT_EMAIL}`}>
            {SUPPORT_EMAIL}
          </a>
        </p>
      </main>
      <TabBar />
    </>
  );
}
