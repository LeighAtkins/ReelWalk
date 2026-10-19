# 0037 - A director run with a credit budget

## Context

The in-app director (ADR 0034) reviews, proposes, and waits: the studio
applies the edit, approves each shot, waits for it, and asks again so Opus
can check the result. Maya's villa reel took nine of those rounds by hand.
The owner asked for two modes: "ask me before using Veo credits", which is
the existing flow, and "make it for me" within a budget.

## Decision

The director sheet gets a mode. **Ask me first** is unchanged. **Make it
for me** takes a credit budget and runs a loop in the browser session:
review → apply the edit as one undoable step → make the first proposed shot
that fits the remaining budget → wait for it → review again with the take
as a candidate and a follow-up brief → until Opus's verdict is ready, it
has no shot to propose, the budget cannot cover the next shot, or four
rounds are done. The decisions live in `packages/core/src/director-loop.ts`
and are tested; the sheet only executes them and can be stopped at any
point, which leaves whatever was made in the library.

The server enforces the budget rather than trusting the browser. Each
review in a run carries the run's id (the first review's edit id) in its
stored plan. Approving a shot "automatically" sends `auto: { runId,
budgetCredits }`; the approval route finds every review in the run,
derives their possible generation request ids, sums the credits of the
generations that exist and are not failed, and refuses when the quoted
shot would take the run past the budget. The same consent and credit-quote
checks as a manual approval still apply, and the request id is still
derived from the review and proposal, so a retried approval cannot charge
twice.

## Consequences

- A run stays in the open editor tab: closing it stops the loop after the
  current step (a shot in progress still completes and is kept). Moving the
  loop into a worker is a later step and needs frame sheets made
  server-side.
- The budget bounds Veo credits only; each review is an Opus call as
  before.
- Opus is told it is directing without the studio in the loop and to keep
  to the brief; its own rules on evidence and scale checks are unchanged.
