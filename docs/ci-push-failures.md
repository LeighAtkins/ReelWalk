# Push and CI failure evidence

Reviewed 2026-10-25. This is a targeted sample, not a claim that every red run has the same cause. Sources are Actions logs, PR descriptions and the current hook/workflow. No production changes or paid AI calls were used.

## Repeated patterns

- **Security findings recur independently of feature correctness.** [Run 39529821493](https://github.com/LeighAtkins/ReelWalk/actions/runs/39529821493) failed the worker Trivy step on four HIGH libssh findings with fixed Debian versions. Later, [PR229](https://github.com/LeighAtkins/ReelWalk/pull/229) records lockfile zod and worker libbrotli1 findings from [run 40054856659](https://github.com/LeighAtkins/ReelWalk/actions/runs/40054856659), addressed by dependency updates and refreshing the base upgrade layer. Inspect the actual package, installed/fixed versions and image layer; a test rerun cannot repair a vulnerable dependency.
- **CI identity and registration matter.** [PR222](https://github.com/LeighAtkins/ReelWalk/pull/222) records three deployment lookup failures: delayed CI registration and matching Dependabot runs sharing the SHA. Its fix selects the CI workflow and allows registration time. The preventive lesson here is to identify the exact workflow and revision before reporting status; this note does not authorize deployment.

## Specific preventable regressions

[PR237](https://github.com/LeighAtkins/ReelWalk/pull/237) supplied two different failures, not one repeatedly failing test:

- [Run 40201274862](https://github.com/LeighAtkins/ReelWalk/actions/runs/40201274862), head `f23e9f64`: core typechecking reached web AI guards and database code before Prisma generation (`TS2307`, missing `./generated/prisma/client`). Local generated artifacts masked the dependency. Commit `723414a8` adds core typecheck/test generation edges; the PR records graph inspection and a forced check with generated files moved aside.
- [Run 40201722318](https://github.com/LeighAtkins/ReelWalk/actions/runs/40201722318), head `723414a8`: typecheck passed, then `track.test.ts` / drift correction / “keeps a long push-in on the truth” exceeded its existing 5000 ms timeout (6347 ms). Commit `838372bc` caps core workers at two. The PR records 100 files / 1265 tests passing with the same scenario/assertions/timeout, the affected test taking 1365 ms locally. This supports investigating contention, not treating every timeout as a worker-count problem or declaring all CI green.

The current `.githooks/pre-push` runs `pnpm check` (lint plus recursive typecheck/test); `.github/workflows/ci.yml` runs root typecheck/test scripts through Turbo. Their scheduling differs. Changes affecting imports or generation therefore need clean-state and task-order verification, not only a warm hook pass.

## External/setup failure and limits

[Run 39802036114](https://github.com/LeighAtkins/ReelWalk/actions/runs/39802036114) timed out in “Install Chromium for Playwright” after eight minutes of slow apt downloads. That is setup failure before browser assertions, not evidence to relax E2E tests. A retry needs a recorded infrastructure reason.

This review does not establish recurring PowerShell argument bugs, generated `next-env` drift, stacked-PR conflicts or image-source/release-SHA confusion. Do not turn those suggested categories into repository policy without additional evidence. Exact-head CI remains the authority for each revision; local passes and this historical sample do not replace it.
