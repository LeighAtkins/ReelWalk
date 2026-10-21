/**
 * Builds the "Popular now" chart (ADR 0058) from a playlist snapshot.
 *
 *   DATABASE_URL=... MUSIC_HOUSE_WORKSPACE_ID=<id> pnpm --filter @reelwalk/worker music-chart --snapshot <file or https URL> [--dry-run] [--force]
 *
 * --snapshot   JSON in the playlistSnapshotSchema shape (@reelwalk/core music-picks.ts):
 *              { source, fetchedAt, playlists: [{ id, name, followers, moods, tracks: [{ title, artist, isrc?, popularity? }] }] }
 * --dry-run    Prints the top picks per mood; writes nothing.
 * --force      Replace the chart even when the snapshot has under half as many songs as are stored.
 *
 * Instagram is searched only with the house account: the workspace in
 * MUSIC_HOUSE_WORKSPACE_ID, whose connected account must be
 * @MUSIC_HOUSE_IG_USERNAME (default @reelwalking). A customer's workspace is
 * never used; there is no option to name one. Without MUSIC_HOUSE_WORKSPACE_ID
 * the songs are scored and stored with their stored matches kept.
 *
 * About two searches per song looked up (at most 60 songs), 1.5 s apart. Rate
 * limiting (429, Graph codes 4/17/32/613) stops the run with nothing written.
 * With DEV_FAKE_INSTAGRAM=true the local stack's pretend library is searched instead.
 */
import { readFile } from "node:fs/promises";
import { MUSIC_MOODS, pickPopularSounds, searchFakeInstagramAudio, type AudioSearch, type PopularSoundRow } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { fetchInstagramAudio, isFakeInstagram } from "@/lib/instagram";
import { HOUSE_IG_USERNAME, houseAccountProblem, MusicChartRefused, pacedSearch, popularRowFromWrite, prismaMusicChartStore, runMusicChart } from "../src/music-chart";

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

async function houseSearch(): Promise<AudioSearch | null> {
  if (isFakeInstagram()) return async (type, query) => searchFakeInstagramAudio(type, query);
  const workspaceId = process.env.MUSIC_HOUSE_WORKSPACE_ID;
  if (!workspaceId) return null;
  const account = await prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId, provider: "instagram" } } });
  const problem = houseAccountProblem(account, process.env.MUSIC_HOUSE_IG_USERNAME || HOUSE_IG_USERNAME);
  if (problem || !account) throw new Error(problem ?? "No house account.");
  return pacedSearch((type, query) => fetchInstagramAudio({ igUserId: account.externalId, token: account.accessToken, type, query }));
}

async function main() {
  if (process.argv.includes("--workspace")) throw new Error("--workspace is not accepted: the job only searches with the house account (MUSIC_HOUSE_WORKSPACE_ID).");
  const from = argument("snapshot");
  if (!from) throw new Error("--snapshot <file or https URL> is required.");
  const dryRun = process.argv.includes("--dry-run");
  const force = process.argv.includes("--force");
  const search = await houseSearch();
  if (!search) console.log("No MUSIC_HOUSE_WORKSPACE_ID: scoring only; stored matches are kept, nothing new is matched.");

  const result = await runMusicChart({ snapshot: await readSnapshot(from), search, store: prismaMusicChartStore(prisma), dryRun, force, log: console.log });
  console.log(
    `${result.songs} songs, ${result.lookedUp} looked up, ${result.matched} matched (${result.covers} covers), ` +
      `${result.searches} searches (${result.failures} failed), ${result.written} written, ${result.removed} removed, ${result.kept} matches kept${dryRun ? " (dry run)" : ""}`,
  );
  if (result.stopped) {
    console.error(result.stopped);
    process.exitCode = 2;
    return;
  }

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
    console.error(error instanceof MusicChartRefused ? `Refused: ${error.message}` : error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
