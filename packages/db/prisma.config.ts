import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // `prisma generate` runs in CI and Docker builds where no database exists,
    // so fall back to the local default instead of failing on a missing variable.
    url: process.env.DATABASE_URL ?? "postgresql://reelwalk:reelwalk@localhost:5432/reelwalk",
  },
});
