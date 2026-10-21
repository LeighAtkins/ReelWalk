import { midFrameMs } from "@reelwalk/core";

/**
 * Inspect's source (ADR 0057): one media element of its own, outside the
 * frame service's shared cache, so opening the original never evicts the
 * file the stage and the loupe are reading, and nothing is copied into a
 * full-size canvas. Inspect draws the visible region straight from the
 * element at the zoom it needs; a step seeks the element (latest wins) and a
 * pan redraws from the frame it is already on. Released when Inspect closes.
 *
 * The media functions are passed in (frame-service.ts in the editor), so the
 * logic is testable without a DOM.
 */

/** A video or photo element; duck-typed so stand-ins work in tests. */
export type SourceMedia = { videoWidth: number; videoHeight: number; duration: number } | { naturalWidth: number; naturalHeight: number };

export type SourceReaderDeps<M extends SourceMedia> = {
  open(src: string, kind: string): Promise<M>;
  seek(media: M, ms: number): Promise<void>;
  free(media: M): void;
};

export type SourceRead<M> = { status: "ready"; media: M; width: number; height: number; seekMs: number } | { status: "superseded" } | { status: "failed" };

const isVideo = (media: SourceMedia): media is Extract<SourceMedia, { videoWidth: number }> => "videoWidth" in media;

export function mediaSize(media: SourceMedia): { width: number; height: number } {
  return isVideo(media) ? { width: media.videoWidth, height: media.videoHeight } : { width: media.naturalWidth, height: media.naturalHeight };
}

export class SourceReader<M extends SourceMedia> {
  private media: Promise<M> | null = null;
  private src: string | null = null;
  private ticket = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private deps: SourceReaderDeps<M>) {}

  /** The element at the frame `sourceMs` falls in (seeked to the frame's middle), or why not. A later read supersedes this one. */
  read(src: string, kind: string, sourceMs: number): Promise<SourceRead<M>> {
    if (src !== this.src) {
      this.release();
      this.src = src;
      this.media = this.deps.open(src, kind);
      this.media.catch(() => undefined);
    }
    const ticket = ++this.ticket, media = this.media!;
    const run = this.queue.then(async (): Promise<SourceRead<M>> => {
      if (ticket !== this.ticket) return { status: "superseded" };
      const element = await media;
      let seekMs = 0;
      if (isVideo(element)) {
        seekMs = Math.max(0, Math.min(midFrameMs(sourceMs), element.duration * 1000 - 20));
        await this.deps.seek(element, seekMs);
      }
      if (ticket !== this.ticket) return { status: "superseded" };
      const { width, height } = mediaSize(element);
      return width && height ? { status: "ready", media: element, width, height, seekMs } : { status: "failed" };
    }).catch((): SourceRead<M> => (ticket === this.ticket ? { status: "failed" } : { status: "superseded" }));
    this.queue = run;
    return run;
  }

  /** Frees the element's decoder and buffer; reads in flight resolve as superseded. */
  release(): void {
    this.ticket++;
    const media = this.media;
    this.media = null; this.src = null;
    // After any read in flight, so a seek is never cut under it.
    if (media) void this.queue.finally(() => media.then((m) => this.deps.free(m)).catch(() => undefined));
  }
}
