/**
 * Who may open /admin/*: the accounts whose email is in ADMIN_EMAILS (comma
 * separated; Terraform sets it, Compose names the demo user). Unset means
 * nobody, so a deployment without the variable has no admin pages.
 */
export function isAdminEmail(email: string): boolean {
  const list = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return list.includes(email.trim().toLowerCase());
}
