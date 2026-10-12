import { sendFeedback } from "@/app/feedback-actions";
import { SubmitButton } from "@/components/submit-button";

/**
 * A short note to the people who make ReelWalk. The same form sits on the
 * account page and at /feedback; `page` records where it was opened from and
 * `back` is where the sender lands afterwards (with ?feedback=sent).
 */
export function FeedbackForm({
  page,
  back,
  status,
  error,
  heading = "Send feedback",
}: {
  page: string | null;
  back: string;
  status: string | undefined;
  error?: string;
  heading?: string;
}) {
  return (
    <form action={sendFeedback} className="card" id="feedback" data-testid="feedback-form">
      <h2>{heading}</h2>
      <p className="muted small">
        Something broken, something missing, something you liked: it goes straight to the people who make ReelWalk, with your email and
        the screen you were on so we can look into it.
      </p>
      <input type="hidden" name="page" value={page ?? ""} />
      <input type="hidden" name="back" value={back} />
      <label className="field">
        Your message
        <textarea className="text-input" name="message" rows={5} required maxLength={4000} data-testid="feedback-message" />
      </label>
      <label className="check">
        <input type="checkbox" name="contactOk" value="yes" defaultChecked />
        <span>You may email me about this.</span>
      </label>
      {status === "error" ? (
        <p className="error small" role="alert">
          {error ?? "Check the form."}
        </p>
      ) : null}
      {status === "sent" ? (
        <p className="toast" role="status" data-testid="feedback-sent">
          Thank you. We read every one.
        </p>
      ) : null}
      <SubmitButton pendingLabel="Sending…" testId="send-feedback">
        Send
      </SubmitButton>
    </form>
  );
}
