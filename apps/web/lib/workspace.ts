import { cache } from "react";
import { DEFAULT_USER_EMAIL, prisma } from "@reelwalk/db";

/**
 * There is no login yet: every request acts as the seeded demo user. All
 * queries still go through this so adding real auth later changes one place.
 */
export const getCurrentUser = cache(async () => {
  const user = await prisma.user.findUnique({ where: { email: DEFAULT_USER_EMAIL }, include: { workspace: true } });
  if (!user) throw new Error("Demo user missing. Run `pnpm db:seed`.");
  return user;
});
