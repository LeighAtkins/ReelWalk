import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Nightly database backup, run as a one-off worker task by an EventBridge
 * schedule (infra/terraform/backups.tf). pg_dump writes ReelWalk's schema in
 * custom format, which pg_restore can restore whole or table by table, and
 * the file goes to a private bucket that keeps two weeks of them.
 *
 * The connection goes to pg_dump through PG* variables, never its command
 * line, so no error message or process listing can show the password.
 */

function connectionEnv(databaseUrl: string): NodeJS.ProcessEnv {
  const url = new URL(databaseUrl);
  // pg_dump needs one session for its snapshot; Supabase's session pooler
  // gives it that, the transaction pooler (6543, used by the app) does not.
  const port = url.port === "6543" ? "5432" : url.port || "5432";
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: port,
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.replace(/^\//, "") || "postgres",
    PGSSLMODE: url.searchParams.get("sslmode") ?? "require",
    PGCONNECT_TIMEOUT: "20",
  };
}

function dump(file: string, env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", "--schema=public", "--file", file], { env });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited with ${code}: ${stderr.trim().slice(0, 500)}`))));
  });
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const bucket = process.env.BACKUP_BUCKET;
  if (!databaseUrl || !bucket) throw new Error("DATABASE_URL and BACKUP_BUCKET are required");

  const dir = await mkdtemp(path.join(os.tmpdir(), "reelwalk-backup-"));
  const file = path.join(dir, "reelwalk.dump");
  try {
    const started = Date.now();
    await dump(file, connectionEnv(databaseUrl));
    const { size } = await stat(file);
    const key = `db/${new Date().toISOString().replace(/[:.]/g, "-")}.dump`;
    const s3 = new S3Client({ region: process.env.AWS_REGION });
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: createReadStream(file), ContentLength: size, ContentType: "application/octet-stream" }));
    console.log(`backup written: s3://${bucket}/${key}, ${size} bytes in ${Math.round((Date.now() - started) / 1000)} s`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  // The message comes from pg_dump's stderr or the AWS SDK; neither carries the password.
  console.error(`backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
