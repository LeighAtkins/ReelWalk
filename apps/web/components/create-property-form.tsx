"use client";

import { useActionState } from "react";
import { createProperty, type FormState } from "@/app/actions";

const initialState: FormState = {};

export function CreatePropertyForm() {
  const [state, formAction, pending] = useActionState(createProperty, initialState);

  return (
    <form action={formAction} className="form">
      <label>
        Title
        <input name="title" required maxLength={120} placeholder="3-bed townhouse, Kanda" />
      </label>
      <label>
        Address
        <input name="address" maxLength={200} placeholder="1-24-5 Kanda Sudacho, Chiyoda" />
      </label>
      <label>
        Description
        <textarea name="description" rows={3} maxLength={2000} />
      </label>
      {state.error ? <p className="error">{state.error}</p> : null}
      <button className="button" type="submit" disabled={pending}>
        {pending ? "Creating…" : "Create property"}
      </button>
    </form>
  );
}
