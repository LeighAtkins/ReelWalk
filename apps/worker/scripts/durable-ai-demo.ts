/**
 * Local demonstration of durable AI steps (ADR 0049) against a migrated,
 * seeded database and the local queue. Each phase is its own process, so the
 * "web" side has exited before the worker runs anything:
 *
 *   tsx scripts/durable-ai-demo.ts start        # the web route's write: run + step + outbox message, then exit
 *   tsx scripts/durable-ai-demo.ts poll <step>  # what /api/ai-jobs/<step> would answer, from a fresh process
 *   tsx scripts/durable-ai-demo.ts crashed      # a step whose worker died after submitting to the provider
 *
 * Start the worker (pnpm dev, DEV_FAKE_AI=true) between `start` and `poll`.
 */
import { emptyTimeline, pollAnswer, serializeAiStepMessage } from "@reelwalk/core";
import { addToOutbox, DEFAULT_USER_EMAIL, prisma, RENDER_JOBS_TOPIC } from "@reelwalk/db";
import { startSingleStepRun } from "@/lib/workflows";

const [phase, arg] = process.argv.slice(2);

async function demoReel() {
  const user = await prisma.user.findFirstOrThrow({ where: { email: DEFAULT_USER_EMAIL }, select: { id: true, workspaceId: true } });
  const timeline = emptyTimeline();
  const reel = await prisma.reel.create({ data: { workspaceId: user.workspaceId, title: "Durable AI demo", timeline } });
  return { user, reel, timeline };
}

if (phase === "start") {
  const { user, reel, timeline } = await demoReel();
  const requestId = crypto.randomUUID();
  const input = { user, reelId: reel.id, kind: "ask" as const, stepKind: "ask" as const, requestId, payload: { request: "Make it calmer", timeline, answers: [] }, baseline: timeline };
  const first = await startSingleStepRun(input);
  const again = await startSingleStepRun(input);
  const changed = await startSingleStepRun({ ...input, payload: { ...input.payload, request: "Something else" } });
  console.log(JSON.stringify({ first, retriedPost: again, changedPayloadSameId: changed }, null, 2));
} else if (phase === "poll") {
  const step = await prisma.workflowStep.findUniqueOrThrow({ where: { id: arg }, select: { status: true, result: true, error: true, attempt: true, submittedAt: true, run: { select: { status: true } } } });
  const answer = pollAnswer(step);
  console.log(JSON.stringify({ step: { status: step.status, attempt: step.attempt, submitted: Boolean(step.submittedAt), run: step.run.status }, answer: answer.status === "DONE" ? { ...answer, result: { ok: (answer.result as { ok?: boolean }).ok, note: (answer.result as { note?: string }).note, baselineGeneration: (answer.result as { baselineGeneration?: string }).baselineGeneration } } : answer }, null, 2));
} else if (phase === "crashed") {
  const { user, reel, timeline } = await demoReel();
  const requestId = crypto.randomUUID();
  const stale = new Date(Date.now() - 10 * 60_000);
  const step = await prisma.$transaction(async (tx) => {
    const run = await tx.workflowRun.create({ data: { workspaceId: user.workspaceId, userId: user.id, reelId: reel.id, kind: "ask", requestId, requestHash: "demo", status: "RUNNING" } });
    const created = await tx.workflowStep.create({ data: { runId: run.id, index: 0, kind: "ask", requestId, requestHash: "demo", status: "RUNNING", attempt: 1, heartbeatAt: stale, startedAt: stale, submittedAt: stale, payload: { request: "Make it calmer", timeline, answers: [] } } });
    await addToOutbox(tx, RENDER_JOBS_TOPIC, serializeAiStepMessage({ stepId: created.id, generation: 1 }));
    return created;
  });
  console.log(JSON.stringify({ crashedStep: step.id }));
} else {
  console.error("usage: durable-ai-demo.ts start | poll <stepId> | crashed");
  process.exitCode = 2;
}
await prisma.$disconnect();
