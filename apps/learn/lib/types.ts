/**
 * Content types for ReelWalk Learn.
 *
 * Japanese text ("JA") uses a small ruby markup:
 *   - `冪等性{べきとうせい}`      a run of kanji followed by its reading in braces.
 *                                The base is the kanji run directly before `{`,
 *                                so annotate whole kanji runs: `書{か}き出{だ}し`.
 *   - `[Kubernetes]{クバネティス}` an explicit base in square brackets, for Latin
 *                                names whose Japanese pronunciation is worth showing.
 * Readings are shown as furigana and are also what the speech engine says,
 * so a reading fixes pronunciation for text-to-speech.
 * Annotate kanji above roughly JLPT N2 and specialist terms; leave everyday
 * kanji (動画, 保存, 確認, 作る) plain.
 */
export type JA = string;

/** One spoken sentence and its English meaning. */
export interface Line {
  ja: JA;
  en: string;
}

export interface Term {
  /** Japanese word with ruby markup, e.g. `冪等性{べきとうせい}`. */
  ja: JA;
  en: string;
  /** Optional usage note in English (register, what engineers actually say). */
  note?: string;
}

export interface QA {
  q: Line;
  /** The model answer, 2-6 short spoken sentences. */
  a: Line[];
  /** One English tip: what the interviewer is checking, or a pitfall. */
  tip?: string;
}

/**
 * How real this piece is in the ReelWalk repo.
 *  - built:    in the code, runs locally and/or in CI.
 *  - local:    the code targets the AWS service, but locally a stand-in runs
 *              (MinIO for S3, ElasticMQ for SQS, kind for EKS).
 *  - designed: written down (ADR, Terraform, manifests) but never deployed.
 */
export type Status = "built" | "local" | "designed";

export type Group = "app" | "data" | "async" | "platform" | "delivery" | "quality" | "aws";

export interface RepoRef {
  /** Repo-relative path, e.g. `packages/core/src/job-status.ts`. */
  path: string;
  /** What to look at there, one short English sentence. */
  what: string;
}

export interface Topic {
  /** Stable id, used in URLs and cross-references. */
  id: string;
  group: Group;
  /** Display name, usually the product name: "SQS", "Server Actions". */
  name: string;
  /** Short Japanese label for the role, e.g. `仕事{しごと}の待{ま}ち行列{ぎょうれつ}`. */
  ja: JA;
  /** How Japanese engineers say the name aloud, in katakana, e.g. "エスキューエス". */
  say: string;
  /** Its job in one sentence. */
  oneLiner: Line;
  /** 4-8 short spoken sentences explaining it, in the order you'd say them. */
  explain: Line[];
  /** Why ReelWalk uses it (and the trade-off), 2-4 sentences. */
  why: Line[];
  status: Status;
  /** One English sentence saying exactly what is real and what is not. */
  statusNote: string;
  inRepo: RepoRef[];
  terms: Term[];
  qa: QA[];
  /** Japanese YouTube search phrases, e.g. "SQS 入門 解説". */
  videoSearch: string[];
  /** Official docs, English or Japanese. */
  docs: { title: string; url: string }[];
  /** Ids of related topics. */
  related: string[];
}

export interface Video {
  /** YouTube video id (11 chars), verified to exist. */
  id: string;
  title: string;
  channel: string;
  /** Topic ids this video covers. */
  topics: string[];
  /** One English sentence: what you will hear and why it's useful. */
  note: string;
  level: "intro" | "intermediate" | "deep";
}

export interface Phrase {
  ja: JA;
  en: string;
  /** When to use it. */
  when?: string;
}

export interface PhraseSet {
  id: string;
  title: Line;
  intro: string;
  phrases: Phrase[];
}

export interface Script {
  id: string;
  title: Line;
  /** Rough speaking time in seconds. */
  seconds: number;
  intro: string;
  lines: Line[];
}
