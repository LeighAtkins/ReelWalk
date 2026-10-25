import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { exportProgressText, isActive, reelSources, referencedAssetIds, sourcesCaption, STOCK_SOURCE_LABELS } from "@reelwalk/core";
import { prisma } from "@reelwalk/db";
import { retryRenderJob } from "@/app/actions";
import { AskForChange } from "@/components/ask-for-change";
import { AutoRefresh } from "@/components/auto-refresh";
import { CaptionEditor } from "@/components/caption-editor";
import { FeatureConsent } from "@/components/feature-consent";
import { BackIcon, DownloadIcon } from "@/components/icons";
import { ShareButton } from "@/components/share-button";
import { ShareLink } from "@/components/share-link";
import { instagramChoiceForSound, instagramSoundAssetId, outputSize, parseReelExportPayload, storyHookMs } from "@reelwalk/core";
import { ExportStage, ExportVideo } from "@/components/export-sound";
import { InstagramPublishing } from "@/components/instagram-publishing";
import { RenderChecksPanel } from "@/components/render-checks";
import { MixPreview } from "@/components/mix-preview";
import { aiEditUsage } from "@/lib/ai-edit";
import { isFakeInstagram, isInstagramConfigured } from "@/lib/instagram";
import { isAiAvailable } from "@/lib/openai";
import { workspacePlan } from "@/lib/plans";
import { appUrl } from "@/lib/app-url";
import { exportDurationMs, fullReelStoryIssue, storyCutOf } from "@/lib/posting";
import { outputUrls } from "@/lib/render-jobs";
import { audioProblemsFrom, ensureChecks, gateFor, withAudio, type ChecksResult } from "@/lib/render-verify";
import { coverUrls, readTimeline } from "@/lib/reels";
import { reelAudioTrace } from "@/lib/sound";
import { getCurrentUser, mediaScope } from "@/lib/workspace";

export const dynamic = "force-dynamic";

export default async function ExportPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ featured?: string }>;
}) {
  const [{ id }, { featured }] = await Promise.all([params, searchParams]);
  const user = await getCurrentUser();
  const reel = await prisma.reel.findFirst({
    where: { id, workspaceId: user.workspaceId },
    include: { renderJobs: { orderBy: { createdAt: "desc" }, take: 1, include: { output: true } } },
  });
  if (!reel) notFound();
  const job = reel.renderJobs[0];
  if (!job) redirect(`/reels/${reel.id}`);
  // AI clips carry an "ai-" id and a completed generation record; either marks the reel as AI content.
  const assetIds = referencedAssetIds(readTimeline(reel.timeline));
  const aiContent = assetIds.some((assetId) => assetId.startsWith("ai-"))
    || (await prisma.aiGeneration.count({ where: { workspaceId: user.workspaceId, status: "SUCCEEDED", assetId: { in: assetIds } } })) > 0;
  // Sources (ADR 0070): the stock clips the reel uses, with their licence, read off the assets' own columns.
  const stockAssets = await prisma.mediaAsset.findMany({
    where: { id: { in: assetIds }, sourceUrl: { not: null }, ...mediaScope(user.workspaceId) },
    select: { id: true, sourceUrl: true, license: true, attribution: true, createdAt: true },
  });
  const sources = reelSources(readTimeline(reel.timeline), Object.fromEntries(stockAssets.map((asset) => [asset.id, asset])));

  const [urls, [cover], base, instagram, { plan, id: planId }, aiUsage] = await Promise.all([
    outputUrls(job),
    coverUrls([readTimeline(reel.timeline)]),
    appUrl(),
    prisma.socialAccount.findUnique({ where: { workspaceId_provider: { workspaceId: user.workspaceId, provider: "instagram" } }, select: { username: true } }),
    workspacePlan(user.workspaceId),
    aiEditUsage(user.workspaceId),
  ]);
  const payload = parseReelExportPayload(job.payload);
  const output = payload.output;
  // The Instagram sound the reel was edited to (ADR 0019), from the asset's own record.
  const soundAssetId = instagramSoundAssetId(payload);
  const soundAsset = soundAssetId
    ? await prisma.mediaAsset.findFirst({
        where: { id: soundAssetId, workspaceId: user.workspaceId, instagramAudioId: { not: null } },
        select: { instagramAudioId: true, instagramTitle: true, instagramArtist: true, fileName: true },
      })
    : null;
  // The audio trace (ADR 0066), read once here: the recommended post volumes go into the sound choice Post and
  // Schedule store, its problems into the checks, and the strip draws it without a second request.
  const trace = urls ? await reelAudioTrace(user.workspaceId, reel.id).catch(() => null) : null;
  const reelSound = soundAsset?.instagramAudioId
    ? instagramChoiceForSound({ audioId: soundAsset.instagramAudioId, title: soundAsset.instagramTitle ?? soundAsset.fileName, artist: soundAsset.instagramArtist }, trace?.recommended)
    : null;
  const scheduled = await prisma.scheduledPost.findFirst({
    where: { renderJobId: job.id, workspaceId: user.workspaceId, kind: "REEL", status: { in: ["SCHEDULED", "PUBLISHING"] } },
    orderBy: { createdAt: "desc" },
    select: { audioId: true, audioTitle: true, audioArtist: true, audioVolume: true, videoVolume: true },
  });
  const scheduledSound = scheduled
    ? scheduled.audioId
      ? { audioId: scheduled.audioId, title: scheduled.audioTitle ?? scheduled.audioId, artist: scheduled.audioArtist, audioVolume: scheduled.audioVolume ?? 100, videoVolume: scheduled.videoVolume ?? 0 }
      : null
    : undefined;
  const active = isActive(job.status);
  const progress = exportProgressText(job, new Date());
  // Stories (ADR 0065): the cut already made for this export, and whether the whole reel fits a story.
  const storyCut = urls ? await storyCutOf(user.workspaceId, job.id) : null;
  const story = { hookMs: storyHookMs(payload.timeline), cut: storyCut ? { status: storyCut.status } : null, fullIssue: fullReelStoryIssue(job), durationMs: exportDurationMs(job) };
  // The render checks (ADR 0071) the worker stored beside the export. Only what is stored: an older
  // export's checks are computed on Run checks (or by an agent on the route), never on a page load.
  const stored: ChecksResult | null = urls
    ? await ensureChecks(job, { compute: false }).catch((): ChecksResult => ({ checks: null, source: "none", reason: "The checks could not be read." }))
    : null;
  // The sound's problems from the trace, folded into the picture's checks as the checks route does.
  const verification: ChecksResult | null = stored?.checks ? { ...stored, checks: withAudio(stored.checks, audioProblemsFrom(trace)) } : stored;
  const gate = gateFor(verification?.checks ?? null);

  return (
    <main className="shell">
      <AutoRefresh active={active} />
      <header className="shell-head">
        <Link href={`/reels/${reel.id}`} className="btn btn-quiet" prefetch={false}>
          <BackIcon size={18} />
          Edit
        </Link>
        <span className="muted small">{reel.title}</span>
      </header>

      <ExportStage>
        <section className="export" data-testid="export" data-status={job.status}>
          <div className="export-frame">
            {urls ? (
              <ExportVideo src={urls.playUrl} />
            ) : (
              <>
                {cover ? <img src={cover} alt="" style={{ opacity: 0.35 }} /> : null}
                {active ? <span className="export-fill" style={{ height: `${job.progress}%` }} /> : null}
                <span className="export-figure" role="status">
                  {active ? (
                    <>
                      <strong className="timecode">{job.progress}%</strong>
                      <span>{progress.phase}</span>
                      {progress.detail ? <span className="small muted">{progress.detail}</span> : null}
                    </>
                  ) : (
                    <>
                      <strong>Failed</strong>
                      <span className="small">{job.error ?? "The render did not finish."}</span>
                    </>
                  )}
                </span>
              </>
            )}
          </div>
  
          {urls ? (
            <>
              <div>
                <h1>Ready for Instagram</h1>
                <p className="muted" style={{ marginTop: 6 }}>
                  {outputSize(output.width).width}×{outputSize(output.width).height} MP4, 30 fps. Share it to Instagram from your phone, download it, or send a link anyone can open.
                  {output.watermark ? " Free exports carry a small ReelWalk mark; the Agent plan removes it and exports at full size." : ""}
                </p>
              </div>
              <div className="export-actions">
                {instagram && plan.instagram ? (
                  <InstagramPublishing jobId={job.id} username={instagram.username} live={isInstagramConfigured() || isFakeInstagram()} reelSound={reelSound} scheduledSound={scheduledSound} aiContent={aiContent} story={story} blocked={gate.blocked ? gate.reasons : null} />
                ) : null}
                {planId === "FREE" && isInstagramConfigured() ? (
                  <Link className="btn btn-quiet export-upsell" href="/account#plan" prefetch={false}>
                    Post straight to Instagram with Agent
                  </Link>
                ) : null}
                <ShareButton url={urls.playUrl} fileName={`${reel.title}.mp4`} caption={reel.caption} />
                <a className="btn btn-quiet" href={urls.downloadUrl} download>
                  <DownloadIcon size={18} />
                  Download
                </a>
                <ShareLink reelId={reel.id} initialUrl={reel.shareToken ? `${base}/r/${reel.shareToken}` : null} />
                <Link className="btn btn-quiet" href={`/reels/${reel.id}`} prefetch={false}>
                  Keep editing
                </Link>
                {/* Variants (ADR 0063): three openings at 15 and 30 s, to post and compare. */}
                <Link className="btn btn-quiet" href={`/reels/${reel.id}/variants`} prefetch={false} data-testid="variants-link">
                  Variants
                </Link>
              </div>
              {verification ? <RenderChecksPanel jobId={job.id} reelId={reel.id} result={verification} /> : null}
              {/* The mix, seen and heard (ADR 0066): loudness, beats, cuts, speech, the recommended sound volume, and a preview at that level. */}
              <MixPreview reelId={reel.id} sound={reelSound} initial={trace} />
            </>
          ) : job.status === "FAILED" ? (
            <form action={retryRenderJob} className="export-actions">
              <input type="hidden" name="jobId" value={job.id} />
              <button className="btn btn-signal" type="submit">
                Retry export
              </button>
            </form>
          ) : (
            <p className="muted small" style={{ textAlign: "center" }}>
              You can leave this screen. The export keeps going and appears under Exports.
            </p>
          )}
  
          {urls && isAiAvailable() ? <AskForChange reelId={reel.id} usage={aiUsage} /> : null}

          <CaptionEditor reelId={reel.id} initial={reel.caption} />

          {sources.length > 0 ? (
            <section className="export-sources" data-testid="export-sources">
              <h2>Sources</h2>
              <p className="muted small">Stock footage in this reel and its licence. Pixabay&apos;s licence asks for no credit; the lines below are there if you want to give it.</p>
              <ul className="export-sources-list">
                {sources.map((source) => (
                  <li key={source.assetId}>
                    <a href={source.url} target="_blank" rel="noreferrer">
                      {source.creator ?? `#${source.id}`}
                    </a>{" "}
                    <span className="muted small">
                      {STOCK_SOURCE_LABELS[source.source]} · {source.license ?? "licence not recorded"}
                      {source.importedAt ? ` · imported ${new Date(source.importedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}` : ""}
                      {" · "}
                      {source.clipIds.length === 1 ? "1 clip" : `${source.clipIds.length} clips`}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="muted small" style={{ whiteSpace: "pre-line" }}>{sourcesCaption(sources)}</p>
            </section>
          ) : null}

          {urls ? (
            <FeatureConsent
              reelId={reel.id}
              consent={reel.featureConsent}
              handle={reel.featureHandle}
              suggestedHandle={instagram?.username ?? null}
              back={`/reels/${reel.id}/export#featured`}
              status={featured}
            />
          ) : null}
        </section>
      </ExportStage>
    </main>
  );
}
