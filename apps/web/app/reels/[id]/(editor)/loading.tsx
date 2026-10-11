import Link from "next/link";
import { CaptionIcon, CloseIcon, DetailsIcon, MusicIcon, PlayIcon, PlusIcon, RedoIcon, SplitIcon, TextIcon, UndoIcon } from "@/components/icons";

const TOOLS = [
  ["Add media", PlusIcon],
  ["Text", TextIcon],
  ["Music", MusicIcon],
  ["Split", SplitIcon],
  ["Details", DetailsIcon],
  ["Caption", CaptionIcon],
] as const;

/**
 * The editor's frame while the reel and its media load. Laid out like the
 * editor itself, so the reel drops into place rather than the page jumping.
 */
export default function Loading() {
  return (
    <div className="editor" aria-busy="true">
      <header className="editor-top">
        {/* Works before the editor does: a slow load is never a trap. */}
        <Link href="/" className="icon-btn" aria-label="Close editor" prefetch={false}>
          <CloseIcon />
        </Link>
        <span className="editor-top-placeholder" aria-hidden="true">
          <span className="skeleton skeleton-line" />
          <span className="skeleton skeleton-line" />
        </span>
        <button type="button" className="btn btn-signal" disabled>
          Export
        </button>
      </header>
      <div className="stage">
        <div className="stage-frame stage-loading" role="status">
          <span className="focus-marks" />
          <span className="visually-hidden">Opening the reel</span>
        </div>
      </div>
      <div className="transport" aria-hidden="true">
        <span className="icon-btn icon-placeholder">
          <PlayIcon />
        </span>
        <span className="skeleton skeleton-line transport-placeholder" />
        <span className="icon-btn icon-placeholder">
          <UndoIcon />
        </span>
        <span className="icon-btn icon-placeholder">
          <RedoIcon />
        </span>
        <span />
      </div>
      <div className="timeline" aria-hidden="true">
        <div className="timeline-track timeline-loading">
          <div className="ruler" />
          <div className="lane lane-clips">
            <span className="skeleton" />
            <span className="skeleton" />
            <span className="skeleton" />
          </div>
          <div className="lane" />
          <div className="lane" />
        </div>
        <span className="playhead" />
      </div>
      <nav className="toolbar" aria-hidden="true">
        <div className="toolbar-scroll">
          {TOOLS.map(([label, Icon]) => (
            <span key={label} className="tool tool-placeholder">
              <Icon />
              {label}
            </span>
          ))}
        </div>
      </nav>
    </div>
  );
}
