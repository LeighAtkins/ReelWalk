import Link from "next/link";
import { isActive, judgeTimesMs, type RenderJobStatus } from "@reelwalk/core";
import { formatDuration } from "@/lib/format";
import type { Thread, ThreadNote, ThreadVersion } from "@/lib/reel-thread";
import { ChecksList } from "./render-checks";
import { BackToVersion, NoteBox } from "./note-box";

/** Frames in a version's strip, CSS px across: four of the opening and four up to the loop. */
const FRAME_W = 64;

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function NoteLine({ note }: { note: ThreadNote }) {
  return (
    <div className="thread-note" data-testid="thread-note" data-status={note.status}>
      <blockquote>“{note.note}”</blockquote>
      <p className="small">{note.reply}</p>
      {note.applied.length > 0 ? (
        <details className="small muted">
          <summary>What changed ({note.applied.length})</summary>
          <ul className="ask-skipped">
            {note.applied.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

function Strip({ version }: { version: ThreadVersion }) {
  const { opening, ending } = judgeTimesMs(version.durationMs ?? 0);
  const src = (ms: number) => `/api/renders/${version.exportId}/frames?t=${ms}ms&w=${FRAME_W * 2}`;
  const frame = (ms: number, caption: string) => (
    <figure className="judge-frame thread-frame" key={`${caption}${ms}`}>
      <img src={src(ms)} alt={`${version.label} at ${(ms / 1000).toFixed(1)} s`} width={FRAME_W} height={Math.round((FRAME_W * 16) / 9)} loading="lazy" />
      <figcaption>{caption}</figcaption>
    </figure>
  );
  return (
    <div className="judge-strip" aria-label={`${version.label}: the opening, then the last moment before it loops`} data-testid="thread-strip">
      {opening.map((ms) => frame(ms, `${(ms / 1000).toFixed(1)} s`))}
      {ending.length ? <span className="judge-gap" aria-hidden /> : null}
      {ending.map((ms, index) => frame(ms, index === ending.length - 1 ? "loop" : `−${(((version.durationMs ?? 0) - ms) / 1000).toFixed(1)}`))}
    </div>
  );
}

function Checks({ version, reelId }: { version: ThreadVersion; reelId: string }) {
  const checks = version.checks?.checks;
  if (!checks) return <p className="muted small">{version.checks?.reason ?? "No checks for this version yet."}</p>;
  const warnings = checks.checks.filter((check) => check.level !== "block").length;
  const summary = checks.blocked ? `Posting blocked: ${checks.blockReasons[0]}` : warnings ? `${warnings} ${warnings === 1 ? "warning" : "warnings"}, nothing blocks posting` : "Checks clear";
  return (
    <details className="thread-checks" data-testid="thread-checks" data-blocked={checks.blocked ? "true" : "false"}>
      <summary className={checks.blocked ? "error small" : "small"}>{summary}</summary>
      <ChecksList checks={checks} judgeHref={`/reels/${reelId}/judge`} />
    </details>
  );
}

/**
 * The reel's thread on the export screen (ADR 0095): a note box, then each
 * version, newest first, with the note that made it, its opening and loop
 * point, its checks, and the way back to it. Notes that changed nothing sit
 * between the versions at their time.
 */
export function ReelThread({ reelId, thread, viewing, available, left, allowed }: { reelId: string; thread: Thread; viewing: string; available: boolean; left: number | null; allowed: number | null }) {
  type Item = { at: string; version?: ThreadVersion; note?: ThreadNote };
  const items: Item[] = [
    ...thread.versions.map((version) => ({ at: version.createdAt, version })),
    ...thread.notes.filter((note) => !note.toExportId && note.status !== "working").map((note) => ({ at: note.createdAt, note })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  // Older notes whose version is no longer in the shown window are not listed again.
  const oldest = thread.versions[thread.versions.length - 1]?.createdAt ?? "";
  const shown = items.filter((item) => item.version || item.at >= oldest);

  return (
    <section className="card thread" id="notes" data-testid="reel-thread">
      <h2>Notes</h2>
      {available ? (
        <>
          <p className="muted small">
            Say what you want different in this version. Opus changes the cut with the editor&apos;s own tools and exports the next version. No AI video and no credits; nothing is posted.
            {left !== null && allowed !== null ? ` ${left} of ${allowed} requests left this month.` : ""}
          </p>
          <NoteBox reelId={reelId} disabled={Boolean(thread.working)} left={left} />
        </>
      ) : (
        <p className="muted small">Notes need Claude, which is not set up here, or AI is turned off for this workspace.</p>
      )}
      {thread.working ? (
        <div className="thread-working" role="status" data-testid="note-working">
          <div>
            <blockquote>“{thread.working.note}”</blockquote>
            <p className="small muted">Opus is working on this note. You can leave this screen; the next version appears here.</p>
          </div>
        </div>
      ) : null}
      <ol className="thread-list plain-list">
        {shown.map((item) =>
          item.version ? (
            <li key={item.version.exportId} className="thread-version" data-testid="thread-version" data-label={item.version.label} data-status={item.version.status} data-current={item.version.current ? "true" : "false"}>
              <div className="thread-head">
                <strong>{item.version.label}</strong>
                <span className="muted small">
                  {item.version.durationMs ? `${formatDuration(item.version.durationMs)} · ` : ""}
                  {when(item.version.createdAt)}
                </span>
                {item.version.current ? <span className="chip">current cut</span> : null}
                {item.version.exportId === viewing ? (
                  <span className="chip">showing</span>
                ) : item.version.status === "SUCCEEDED" ? (
                  <Link className="link small" href={`/reels/${reelId}/export?v=${item.version.exportId}`} prefetch={false}>
                    Watch
                  </Link>
                ) : null}
              </div>
              {item.version.note ? <NoteLine note={item.version.note} /> : null}
              {item.version.status === "SUCCEEDED" ? (
                <>
                  <Strip version={item.version} />
                  <Checks version={item.version} reelId={reelId} />
                  {!item.version.current ? <BackToVersion reelId={reelId} exportId={item.version.exportId} label={item.version.label} /> : null}
                </>
              ) : isActive(item.version.status as RenderJobStatus) ? (
                <p className="small muted">Rendering…</p>
              ) : (
                <p className="small error">This export failed.</p>
              )}
            </li>
          ) : (
            <li key={item.note!.id} className="thread-version thread-orphan">
              <NoteLine note={item.note!} />
            </li>
          ),
        )}
      </ol>
    </section>
  );
}
