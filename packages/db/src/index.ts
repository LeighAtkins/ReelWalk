import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client";

export * from "./generated/prisma/client";
export * from "./outbox";
export * from "./password";
export * from "./ai-credits";
export * from "./scheduled-posts";

export const DEFAULT_WORKSPACE_SLUG = "demo";
export const DEFAULT_USER_EMAIL = "demo@reelwalk.local";

function createClient(): PrismaClient {
  const connectionString = process.env.DATABASE_URL ?? "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk";
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString,
      // Every web instance and render worker shares the database's connection
      // pooler, so each process keeps a small pool (DATABASE_POOL_MAX), and a
      // query that cannot get a connection fails in seconds instead of hanging.
      max: Number(process.env.DATABASE_POOL_MAX ?? 5),
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    }),
  });
}

// Next.js dev reloads modules on every change; keep one client (and one
// connection pool) per process instead of one per reload.
const globalForPrisma = globalThis as unknown as { reelwalkPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.reelwalkPrisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.reelwalkPrisma = prisma;
}

export * from "./guest";
