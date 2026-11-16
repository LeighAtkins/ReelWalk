"use client";

import { useState } from "react";
import { unstable_rethrow } from "next/navigation";
import type { CampaignFacts } from "@reelwalk/core";

const fields = [
  ["address", "Address or suburb", 80], ["price", "Price", 24], ["beds", "Beds", 6], ["baths", "Baths", 6],
  ["area", "Size", 16], ["contact", "Contact", 60], ["openHome", "Open-home day and time", 60],
] as const;

export function CampaignFactsForm({ initial, action, campaign, sources, selectedSourceId, requestKey }: {
  initial: CampaignFacts; action(form: FormData): Promise<void | { error: string }>; requestKey: string;
  campaign?: { id: string; title: string; revision: number; reels: Record<string, number> };
  sources?: { id: string; title: string; revision: number }[];
  selectedSourceId?: string;
}) {
  const [values, setValues] = useState(initial);
  const [title, setTitle] = useState("");
  const [source, setSource] = useState(() => {
    const selected = sources?.find(item => item.id === selectedSourceId) ?? sources?.[0];
    return selected ? JSON.stringify({ id: selected.id, revision: selected.revision }) : "";
  });
  const [verified, setVerified] = useState(false);
  const [operationKey] = useState(requestKey);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return <form action={async form => {
    try { const result = await action(form); if (result?.error) setError(result.error); }
    catch (error) { unstable_rethrow(error); setError("The connection failed. Your details are kept here; retry the same request."); }
    finally { setBusy(false); }
  }} onSubmit={(event) => {
    if (!reviewing) { event.preventDefault(); setReviewing(true); return; }
    setError("");
    setBusy(true);
  }} className="stack" data-testid="campaign-facts-form">
    <input type="hidden" name="requestKey" value={operationKey} />
    {campaign ? <>
      <input type="hidden" name="campaignId" value={campaign.id} />
      <input type="hidden" name="revision" value={campaign.revision} />
      <input type="hidden" name="reels" value={JSON.stringify(campaign.reels)} />
    </> : <>
      <label className="field">Campaign name<input name="title" className="text-input" required maxLength={60} value={title} onChange={event => { setTitle(event.target.value); setReviewing(false); }} /></label>
      <label className="field">Accepted source reel<select className="text-input" name="source" required value={source} onChange={event => { setSource(event.target.value); setReviewing(false); }}>{sources?.map((source) => <option key={source.id} value={JSON.stringify({ id: source.id, revision: source.revision })}>{source.title}</option>)}</select></label>
    </>}
    {fields.map(([key, label, max]) => <label className="field" key={key}>{label}<input className="text-input" name={key} value={values[key]} maxLength={max} required={key === "openHome"} onChange={(event) => { setValues({ ...values, [key]: event.target.value }); setReviewing(false); }} /></label>)}
    <label className="field">Source credits and AI disclosures<textarea className="text-input" name="disclosure" value={values.disclosure} required maxLength={1200} rows={4} onChange={(event) => { setValues({ ...values, disclosure: event.target.value }); setReviewing(false); }} /></label>
    <label><input type="checkbox" name="verified" value="yes" required checked={verified} onChange={event => { setVerified(event.target.checked); setReviewing(false); }} /> I verified these facts and have permission to use the source media.</label>
    {reviewing ? <section aria-live="polite" data-testid="campaign-update-preview">
      <h3>{campaign ? "Review shared update" : "Review campaign"}</h3>
      <p>These details will appear on the Hero, Teaser and Open home cards and captions. Only Open home includes the event time.</p>
      <dl>{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{values[key] || "Not shown"}{campaign && initial[key] !== values[key] ? ` (was ${initial[key] || "not shown"})` : ""}</dd></div>)}</dl>
      <p style={{ whiteSpace: "pre-wrap" }}>{values.disclosure}</p>
      {campaign ? <p>Footage and other text stay as edited. Existing review links and approvals will be revoked. Export and request review again when ready.</p> : <p>Three editable cuts reuse your accepted footage. No new AI footage is generated. Export each cut when ready.</p>}
      <button type="button" className="btn btn-quiet" onClick={() => setReviewing(false)}>Keep editing</button>
    </section> : null}
    {error ? <p role="alert">{error}</p> : null}
    <button className="btn" type="submit" disabled={busy || (!campaign && !sources?.length)}>{busy ? "Saving…" : reviewing ? campaign ? "Apply to all three outputs" : "Create three editable cuts" : "Preview details"}</button>
  </form>;
}
