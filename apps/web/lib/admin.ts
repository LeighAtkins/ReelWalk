/**
 * Who may open /admin/*: accounts with User.isAdmin set. Nothing in the app
 * sets it (signup never verifies an email, so an address is no credential);
 * `packages/db/scripts/set-admin.ts <email>` flips it by hand.
 */
export function isAdmin(user: { isAdmin: boolean }): boolean {
  return user.isAdmin;
}
