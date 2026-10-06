import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export * from "./outbox";
export * from "./password";

export const DEFAULT_WORKSPACE_SLUG = "demo";
export const DEFAULT_USER_EMAIL = "demo@reelwalk.local";

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL ?? "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk";
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// Next.js dev reloads modules on every change; keep one client (and one
// connection pool) per process instead of one per reload.
const globalForPrisma = globalThis as unknown as { reelwalkPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.reelwalkPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.reelwalkPrisma = prisma;
}
