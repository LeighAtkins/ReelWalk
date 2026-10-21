/**
 * Builds the "Popular now" chart (ADR 0058) from a playlist snapshot.
 *
 *   DATABASE_URL=... pnpm --filter @reelwalk/worker music-chart --snapshot <file or https URL> --workspace <id> [--dry-run]
 *
 * --snapshot   JSON in the playlistSnapshotSchema shape (@reelwalk/core music-picks.ts):
 *              { source, fetchedAt, playlists: [{ id, name, followers, moods, tracks: [{ title, artist, isrc?, popularity? }] }] }
 * --workspace  A workspace whose connected Instagram business account is used to search
 *              Instagram's audio library (or MUSIC_IG_WORKSPACE_ID). Without one the songs
 *              are scored and stored but nothing is matched, so the editor offers nothing.
 * --dry-run    Prints the top picks per mood; writes nothing.
 *
 * Instagram is searched about twice per song looked up (at most 60 songs), 1.5 s apart.
 * With DEV_FAKE_INSTAGRAM=true the local stack's pretend library is searched instead.
 */
import { readFile } from "node:fs/promises";
import { MUSIC_MOODS, pickPopularSounds, searchFakeInstagramAudio, type AudioSearch, type PopularSoundRow } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { fetchInstagramAudio, isFakeInstagram } from "@/lib/instagram";
import { pacedSearch, popularRowFromWrite, prismaMusicChartStore, runMusicChart } from "../src/music-chart";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readSnapshot(from: string): Promise<unknown> {
  if (/^https:\/\//.test(from)) {
    const response = await fetch(from, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`The snapshot did not download (${response.status}).`);
    return response.json();
  }
  return JSON.parse(await readFile(from, "utf8"));
}

async function instagramSearch(workspaceId: string | undefined): Promise<AudioSearch | null> {
  if (isFakeInstagram()) return async (type, query) => searchFakeInstagramAudio(type, query);
  if (!workspaceId) return null;
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  if (!account) throw new Error("That workspace has no connected Instagram account.");
  if (account.expiresAt && account.expiresAt.getTime() < Date.now()) throw new Error("That workspace's Instagram connection has expired.");
  return pacedSearch((type, query) => fetchInstagramAudio({ igUserId: account.externalId, token: account.accessToken, type, query }));
}

async function main() {
  const from = argument("snapshot");
  if (!from) throw new Error("--snapshot <file or https URL> is required.");
  const dryRun = process.argv.includes("--dry-run");
  const search = await instagramSearch(argument("workspace") ?? process.env.MUSIC_IG_WORKSPACE_ID);
  if (!search) console.log("No --workspace: scoring only, nothing will be matched to Instagram.");

  const result = await runMusicChart({ snapshot: await readSnapshot(from), search, store: prismaMusicChartStore(prisma), dryRun, log: console.log });
  console.log(
    `${result.songs} songs, ${result.lookedUp} looked up, ${result.matched} matched (${result.covers} covers), ` +
      `${result.searches} searches (${result.failures} failed), ${result.written} written, ${result.removed} removed${dryRun ? " (dry run)" : ""}`,
  );

  const rows = result.rows.map(popularRowFromWrite).filter((row): row is PopularSoundRow => row !== null);
  for (const mood of MUSIC_MOODS) {
    console.log(`\n## ${mood.label}`);
    for (const pick of pickPopularSounds(rows, { moods: [mood.id], reelMs: 30_000 })) {
      console.log(`${pick.track.id} | ${pick.track.title} — ${pick.track.artist ?? "?"} | ${pick.why}${pick.bpm ? ` | ${Math.round(pick.bpm)} bpm` : ""}`);
    }
  }
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
