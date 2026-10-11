import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/index";

const url = process.env.DATABASE_URL!.replace(":5432/", ":6543/");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url, max: 5, connectionTimeoutMillis: 5000 }) });
const t0 = Date.now();
const [v] = await prisma.$queryRawUnsafe<{ version: string }[]>("select version()");
console.log("server:", v.version.split(" ").slice(0, 2).join(" "), `${Date.now() - t0} ms`);
console.log("users:", await prisma.user.count(), "reels:", await prisma.reel.count());
// Interactive transaction with a row lock, like the outbox relay and claim.
const r = await prisma.$transaction(async (tx) => {
  const rows = await tx.$queryRawUnsafe<{ id: string }[]>(`select id from "OutboxMessage" order by "availableAt" limit 5 for update skip locked`);
  const n = await tx.reel.count();
  return { locked: rows.length, n };
});
console.log("transaction ok:", JSON.stringify(r));
// 40 concurrent queries through a pool of 5.
const t1 = Date.now();
const results = await Promise.allSettled(Array.from({ length: 40 }, (_, i) => prisma.reel.findMany({ take: 3, orderBy: { updatedAt: "desc" }, select: { id: true } })));
console.log("40 concurrent:", results.filter((x) => x.status === "fulfilled").length, "ok,", results.filter((x) => x.status === "rejected").length, "failed,", `${Date.now() - t1} ms`);
const bad = results.find((x) => x.status === "rejected") as PromiseRejectedResult | undefined;
if (bad) console.log("first error:", String(bad.reason).slice(0, 200));
await prisma.$disconnect();
