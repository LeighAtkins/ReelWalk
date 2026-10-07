"use client";

import { useFormStatus } from "react-dom";

/**
 * A form submit that acknowledges the tap: disabled with a "working" label
 * while the Server Action runs, so a slow network or a cold database never
 * looks like a dead button.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = "btn btn-block",
  testId,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  className?: string;
  testId?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button className={className} type="submit" disabled={pending} aria-busy={pending} data-testid={testId}>
      {pending ? pendingLabel : children}
    </button>
  );
}
