import { prisma } from "@reelwalk/db";
import { commentsToAnswer } from "@reelwalk/core";
import {
  isMessagingConfigured,
  isTransientInstagramError,
  recentComments,
  refreshMessagingToken,
  replyToComment,
  sendPrivateReply,
} from "./instagram-messaging";

/**
 * One pass of keyword comment replies (ADR 0026), run from the scheduled
 * post tick. Each workspace with an enabled trigger and a messaging token
 * gets one read of the comments on its recent posts; each new comment naming
 * a keyword is claimed by inserting its CommentReply (commentId is unique, so
 * two instances never both answer), then gets its DM and the optional public
 * reply. A transient failure releases the claim for the next pass.
 */
const MIN_GAP_MS = 2 * 60_000;
const REFRESH_WITHIN_MS = 10 * 24 * 3600_000;
const state = globalThis as unknown as { reelwalkCommentRepliesAt?: number };

export async function answerKeywordComments(now = new Date()): Promise<{ checked: number; sent: number; failed: number } | null> {
  if (!isMessagingConfigured()) return null;
  if (state.reelwalkCommentRepliesAt && now.getTime() - state.reelwalkCommentRepliesAt < MIN_GAP_MS) return null;
  state.reelwalkCommentRepliesAt = now.getTime();

  const accounts = await prisma.socialAccount.findMany({
    where: { provider: "instagram", messagingToken: { not: null }, workspace: { commentTriggers: { some: { enabled: true } } } },
    include: { workspace: { select: { commentTriggers: { where: { enabled: true }, orderBy: { createdAt: "asc" } } } } },
  });
  let sent = 0;
  let failed = 0;
  for (const account of accounts) {
    try {
      let token = account.messagingToken!;
      if (account.messagingExpiresAt && account.messagingExpiresAt.getTime() < now.getTime()) continue;
      if (account.messagingExpiresAt && account.messagingExpiresAt.getTime() - now.getTime() < REFRESH_WITHIN_MS) {
        const fresh = await refreshMessagingToken(token);
        token = fresh.accessToken;
        await prisma.socialAccount.update({ where: { id: account.id }, data: { messagingToken: fresh.accessToken, messagingExpiresAt: fresh.expiresAt } });
      }

      const triggers = account.workspace.commentTriggers;
      const comments = await recentComments(token);
      const answered = new Set(
        (await prisma.commentReply.findMany({ where: { commentId: { in: comments.map((c) => c.id) } }, select: { commentId: true } })).map((r) => r.commentId),
      );
      const todo = commentsToAnswer({ comments, triggers, answered, ownUsername: account.username, now });
      for (const { comment, trigger } of todo) {
        const full = triggers.find((t) => t.id === trigger.id)!;
        const claim = await prisma.commentReply
          .create({ data: { triggerId: full.id, commentId: comment.id, mediaId: comment.mediaId, username: comment.username, text: comment.text.slice(0, 500) } })
          .catch(() => null);
        if (!claim) continue;
        try {
          await sendPrivateReply(token, comment.id, full.message);
        } catch (error) {
          if (isTransientInstagramError(error)) {
            await prisma.commentReply.delete({ where: { id: claim.id } });
          } else {
            failed++;
            await prisma.commentReply.update({ where: { id: claim.id }, data: { status: "FAILED", error: (error as Error).message.slice(0, 300) } });
          }
          continue;
        }
        sent++;
        await prisma.commentReply.update({ where: { id: claim.id }, data: { status: "SENT" } });
        if (full.publicReply) await replyToComment(token, comment.id, full.publicReply).catch((e) => console.warn("comment replies: public reply failed", e));
      }
    } catch (error) {
      console.error("comment replies: pass failed for", account.username, error);
    }
  }
  return { checked: accounts.length, sent, failed };
}
