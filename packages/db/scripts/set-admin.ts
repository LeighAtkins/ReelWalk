// Makes an account an admin (may open /admin/*), or takes it away. Done by
// hand, on purpose: signup never verifies an email, so nothing automatic
// should grant this.
//
//   DATABASE_URL=... npx tsx scripts/set-admin.ts <email> [off]
import { prisma } from "../src/index";

const [email, flag] = process.argv.slice(2);
if (!email || (flag && flag !== "off")) {
  console.error("usage: set-admin.ts <email> [off]");
  process.exit(2);
}
const isAdmin = flag !== "off";
const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() }, select: { id: true, isAdmin: true } });
if (!user) {
  console.error(`no account with email ${email}`);
  process.exit(1);
}
await prisma.user.update({ where: { id: user.id }, data: { isAdmin } });
console.log(`${email}: admin ${user.isAdmin ? "on" : "off"} -> ${isAdmin ? "on" : "off"}`);
await prisma.$disconnect();
