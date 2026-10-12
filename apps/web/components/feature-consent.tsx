import { setFeatureConsent } from "@/app/featured-actions";
import { SubmitButton } from "@/components/submit-button";

/**
 * The owner's say over whether ReelWalk may repost this export. Shown next
 * to a finished export, on the export screen and on the owner's own share
 * page; the same checkbox withdraws it.
 */
export function FeatureConsent({
  reelId,
  consent,
  handle,
  suggestedHandle,
  back,
  status,
}: {
  reelId: string;
  consent: boolean;
  handle: string | null;
  /** The connected Instagram account, offered when no handle is stored yet. */
  suggestedHandle: string | null;
  back: string;
  status: string | undefined;
}) {
  return (
    <form action={setFeatureConsent} className="card" id="featured" data-testid="feature-consent" data-consent={consent ? "on" : "off"}>
      <h2>Feature my reel</h2>
      <input type="hidden" name="reelId" value={reelId} />
      <input type="hidden" name="back" value={back} />
      <label className="check">
        <input type="checkbox" name="consent" value="yes" defaultChecked={consent} data-testid="feature-consent-box" />
        <span>
          Let ReelWalk feature this reel on <strong>@reelwalking</strong> and our site, with credit to the handle below. You can withdraw
          this any time by unticking the box here and saving; we stop using the reel from then on.
        </span>
      </label>
      <label className="field">
        Instagram handle to credit <span className="muted small">(optional)</span>
        <input
          className="text-input"
          name="handle"
          defaultValue={handle ?? suggestedHandle ?? ""}
          placeholder="@yourhandle"
          maxLength={60}
          autoCapitalize="none"
          autoCorrect="off"
          data-testid="feature-handle"
        />
      </label>
      {status === "on" ? (
        <p className="toast" role="status" data-testid="feature-saved">
          Thank you. We may feature this reel{handle ? `, crediting @${handle}` : ""}.
        </p>
      ) : null}
      {status === "badhandle" ? (
        <p className="toast" role="alert" data-testid="feature-saved">
          Handle not saved: use letters, numbers, dots or underscores. Your choice above was saved.
        </p>
      ) : null}
      {status === "off" ? (
        <p className="toast" role="status" data-testid="feature-saved">
          Saved. We will not feature this reel.
        </p>
      ) : null}
      <SubmitButton className="btn btn-quiet btn-block" pendingLabel="Saving…" testId="save-featured">
        Save
      </SubmitButton>
    </form>
  );
}
