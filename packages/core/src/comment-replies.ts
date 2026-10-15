/**
 * Keyword comment replies (ADR 0026): "Comment REEL and I'll send you the
 * guide". Which comments on a workspace's recent posts get a private reply.
 * Pure; the web app fetches the comments and sends.
 */

/** Instagram accepts a private reply up to 7 days after a comment on a post or reel. */
export const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
export const COMMENT_KEYWORD_MAX = 30;
export const COMMENT_MESSAGE_MAX = 1000;

/** A keyword as stored: one word of letters or digits, upper case. Null when there is none. */
export function normalizeCommentKeyword(input: string): string | null {
  const word = input.trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "").toUpperCase();
  if (!word || word.length > COMMENT_KEYWORD_MAX || !/^[\p{L}\p{N}]+$/u.test(word)) return null;
  return word;
}

/** Whether a comment says the keyword as a whole word, in any case ("reel!", "REEL please", "Reel 🙏"). */
export function commentMentionsKeyword(text: string, keyword: string): boolean {
  const words = text.toUpperCase().split(/[^\p{L}\p{N}]+/u);
  return words.includes(keyword.toUpperCase());
}

export type IncomingComment = { id: string; mediaId: string; text: string; timestamp: string; username?: string | null };
export type ReplyTrigger = { id: string; keyword: string };

/**
 * The comments to answer now and the trigger each answers to: inside the
 * 7-day window, not written by the account itself, not answered before, and
 * naming an enabled keyword (the first trigger that matches wins).
 */
export function commentsToAnswer(input: {
  comments: IncomingComment[];
  triggers: ReplyTrigger[];
  answered: ReadonlySet<string>;
  ownUsername: string | null;
  now: Date;
}): { comment: IncomingComment; trigger: ReplyTrigger }[] {
  const own = input.ownUsername?.toLowerCase() ?? null;
  const out: { comment: IncomingComment; trigger: ReplyTrigger }[] = [];
  for (const comment of input.comments) {
    if (input.answered.has(comment.id)) continue;
    if (own && comment.username?.toLowerCase() === own) continue;
    const at = Date.parse(comment.timestamp);
    if (!Number.isFinite(at) || input.now.getTime() - at > PRIVATE_REPLY_WINDOW_MS) continue;
    const trigger = input.triggers.find((t) => commentMentionsKeyword(comment.text, t.keyword));
    if (trigger) out.push({ comment, trigger });
  }
  return out;
}
