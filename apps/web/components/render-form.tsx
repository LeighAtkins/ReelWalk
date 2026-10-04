"use client";

import { useActionState } from "react";
import { createRenderJob, type FormState } from "@/app/actions";

type RenderFormProps = {
  propertyId: string;
  media: { id: string; label: string }[];
  templates: { id: string; name: string; description: string; defaultCaption: string }[];
};

const initialState: FormState = {};

export function RenderForm({ propertyId, media, templates }: RenderFormProps) {
  const [state, formAction, pending] = useActionState(createRenderJob, initialState);

  if (media.length === 0) {
    return (
      <p className="empty">
        <strong>Nothing to render from yet.</strong>
        Upload a photo or video above first.
      </p>
    );
  }

  return (
    <form action={formAction} className="form">
      <input type="hidden" name="propertyId" value={propertyId} />
      <label>
        Media
        <select name="mediaAssetId" required defaultValue={media[0].id}>
          {media.map((asset) => (
            <option key={asset.id} value={asset.id}>
              {asset.label}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend>Template</legend>
        {templates.map((template, index) => (
          <label key={template.id} className="choice">
            <input type="radio" name="templateId" value={template.id} defaultChecked={index === 0} required />
            <span className="choice-text">
              <strong>{template.name}</strong>
              <span className="muted small">{template.description}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label>
        Caption
        <input name="caption" maxLength={120} placeholder="Leave empty to use the template's caption" />
      </label>
      {state.error ? <p className="error">{state.error}</p> : null}
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Sending to render…" : "Render reel"}
      </button>
    </form>
  );
}
