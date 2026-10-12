// Gives a studio a plan by hand, for testers and goodwill, without Stripe.
//
//   DATABASE_URL=... npx tsx scripts/comp.ts <email> <AGENT|OFFICE|FREE> [days=90]
//
// FREE removes a comped plan. A paid subscription always takes precedence.
import { prisma } from "../src/index";

// Mirrors PlanId in @reelwalk/core, which this package does not depend on.
const PLAN_IDS = ["FREE", "AGENT", "OFFICE"] as const;
const isPlanId = (value: unknown): value is (typeof PLAN_IDS)[number] => typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value);

const [email, planArg, daysArg] = process.argv.slice(2);
const plan = planArg?.toUpperCase();
if (!email || !isPlanId(plan)) {
  console.error("usage: comp.ts <email> <AGENT|OFFICE|FREE> [days]");
  process.exit(2);
}
const days = Number(daysArg ?? 90);
const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { workspaceId: true, workspace: { select: { name: true } } } });
if (!user) {
  console.error(`no account with email ${email}`);
  process.exit(1);
}
const until = plan === "FREE" ? null : new Date(Date.now() + days * 86_400_000);
await prisma.workspace.update({
  where: { id: user.workspaceId },
  data: { compedPlan: plan === "FREE" ? null : plan, compedUntil: until },
});
console.log(plan === "FREE" ? `${user.workspace.name}: comped plan removed` : `${user.workspace.name}: ${plan} until ${until!.toISOString().slice(0, 10)}`);
await prisma.$disconnect();
