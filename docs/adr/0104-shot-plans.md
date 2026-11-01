# 0104 — Shot plans: plan the joins, storyboard them, then one take at a time

Date: 2026-11-01

## Context

Making a multi-shot AI sequence one prompt at a time keeps going wrong in the same ways. The owner found these by hand
in finished reels:

- A transition that fights the footage: a spin transition on a staircase shot whose camera never turned.
- The same view again and again, or one shot cut into two to fake pace.
- A reveal already in view: the chandelier in the presenter's shot before "now look up".
- Drift: one take goes off the rails, the shots around it no longer join, and the whole sequence is made again.

Each fix happened after paying for the takes. The owner asked for a standard function:

- list the shots;
- plan each start and end frame, each camera move and each transition, and how they tie together;
- make the next take only after the one before it is right, from start and end frames.

They also asked for the plan to help the people who pay for takes, for whom a bad sequence spoils the product.

## Decision

A **shot plan** is a list of up to 12 shots (90 s), each one take of 4 or 8 s with one continuous camera move. A shot
has:

- its place and point of view;
- its planned motion (`PLAN_MOTIONS`: push-in, pan-left, tilt-up, rise, orbit, roll…) and optionally a named move
  (ADR 0076);
- the operator's description of the action;
- a start frame and an end frame;
- whether the presenter is in it, and her line;
- `transitionOut`: continuous, cut, match-cut, whip with a direction, speed-ramp, or dissolve.

A frame is a `keyframe` (a still to make, or a library frame the owner picked), `previous` (the previous shot's end;
the two shots join on one picture), or `free` (an end only, when the next shot cuts away). Everything that decides is
pure, in `packages/core/src/shot-plan.ts`, and tested.

### 1. Plan

`POST /api/plans`, or the connector's `plan_shots`:

- Claude writes the plan through `structuredAnswer`, from the brief, the presenter kit (if any), a style reference's
  recipe (ADR 0102) and footage the owner offers as frames.
- The instructions carry the owner's rules: variety, transitions that match the camera, reveals not in view, the hook in
  the first second, momentum from speed and not repetition, and real space.
- `planIssues` checks the joins. Each check is one of the faults above:
  - a whip must turn the way both shots turn;
  - a match cut keeps one move;
  - a speed ramp needs a moving camera;
  - a continuous join starts the next shot on this one's end and never reverses the camera;
  - the same place from the same point of view twice in a row is refused;
  - a reveal named in the shots before is warned about;
  - a line needs the presenter and time to say it.
- Errors get one repair round with the problems listed.
- The plan is saved unstarted with its credit estimate. Nothing is spent until the owner starts it, confirming the
  budget the same way as a single take's quote (ADR 0101).

### 2. Storyboard

The worker makes a keyframe still for every planned frame (`VertexImages.keyframe`, Gemini image). It uses the plan's
`look` sentence, the outfit and references:

- the presenter kit's photos;
- for an end frame, the shot's own start ("the same place, the camera moved");
- for a start frame, the previous shot's end.

A frame with the presenter goes through the identity gate (ADR 0056). It is remade once, then refused rather than
allowed to drift. Stills are library images (`kf-<plan>-<shot>-<end>`). The plan stops for the owner unless its
approval is `auto`.

### 3. Takes, one at a time

`nextPlanStep` makes shot n only when every shot before it has a take that was kept.

- **Making a take.** A take goes through `createAiGeneration`, so it has the editor's reservation, credits, queue and
  voice handling. It is a bridge from the start still to the end still, with the plan's prompt (`takePrompt`).
- **Checking it** (`checkTake`, on the take's 72×128 grey frames, `measureTake`):
  - it opens on its start still and lands on its end still (`pickMatchingFrame`, within 6 %);
  - the camera moves the planned way across the middle 60 % (`readMotion`, ADR 0074: the sign and axis of the
    measured flow against `expectedRead`).
- **A failed take** is made again with the correction written into the prompt (`retryNote`), up to three times. The plan
  then stops for the owner, who can keep a take anyway or redo the shot with a note.
- **A continuing shot** starts from the kept take's real last frame. That is the join the cut shows, not the planned
  still.
- **A redo** remakes that shot and every shot continuing from it (`requestRedo`).
- **Approval.** `each-take` stops after every passed take; `storyboard` and `auto` keep a passed take on their own.

### 4. Assemble

The kept takes go into a new reel in order (`planTimeline`):

- each at its planned play length (an 8 s flight can play in 4.8 s);
- the frame repeated at a continuous join is skipped;
- a dissolve becomes a fade;
- a speed ramp puts `into-cut` on the outgoing clip.

A redo assembles the same reel again.

### Running it

- The `ShotPlan` table (new, migration `20261101020000_shot_plans`) holds the plan, its state (the takes and their
  checks), its issues, its approval, budget and presenter, and the reel.
- The worker's AI loop calls `processShotPlans`. It claims one due running plan under a lease, refreshes its takes, does
  up to four steps, and saves after every step: a take started is money spent and is never started twice. Take request
  ids are derived from the plan, the shot and the take's index.
- A step that fails twice the same way stops the plan with the error.
- The provider parts are injected: `shot-plans-deps.ts` holds the real ones, and tests run the loop on fakes.

### Where the owner sees it

- **App:** "Plan an AI sequence" on the home screen (`/plans`). `/plans/<id>` shows every shot's start and end still,
  the transition into the next, the takes with their check results, and the decisions: start, approve the storyboard,
  keep a take, redo with a note, stop.
- **Connector:** `plan_shots`, `get_shot_plan` and `update_shot_plan` (start, approve_storyboard, accept_take, redo,
  stop, edit). One call starts a whole sequence that the worker makes. Separately, `generate_ai_shot` now counts only
  confirmed starts against its ten an hour; a quote has its own limit of sixty, so asking the price never uses up a
  start.

## Not in this step

1. Composing the presenter into a real footage plate for a keyframe (ADR 0036's compose). The storyboard makes her
   frames from her kit; footage frames are used as they are.
2. Checking a voiced take's words. Its trim and transcript are as for any take (ADR 0069), but the plan does not judge
   them yet.
3. Titles, music and the end card on the assembled reel. That is the editor's and the connector's work after assembly.
4. Running takes whose joins are fixed keyframes in parallel. Shots that join on planned stills are independent and could
   be made together. One at a time is the owner's ask and the safer default.
