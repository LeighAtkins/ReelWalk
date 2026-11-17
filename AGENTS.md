<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Push and CI discipline

- Preserve `.githooks/pre-push` and the checks in `.github/workflows/ci.yml`; do not bypass a failed check to ship code. For documentation-only work, use proportionate validation and disclose any hook bypass and unrun checks in the PR.
- When imports, generated clients or task dependencies change, verify generation from an isolated clean state and inspect the task graph. The hook's recursive `pnpm check` and CI's root typecheck/test scripts schedule work differently; a warm local pass is not proof of CI parity. Declare generation prerequisites for every consuming task, including indirect test imports; do not commit generated output to hide missing ordering.
- Before retrying a failure, record the workflow/run, tested SHA, failed job/step and first actionable error. Distinguish code/test failures, vulnerability findings and runner/network setup failures. Read scanner package/version/fix details or E2E artifacts as appropriate; rerun only with a stated reason, and do not suppress scans to obtain green checks.
- Preserve test assertions, scenarios and timeouts when investigating flakes. Check task/suite contention and measure a bounded reproduction before changing concurrency; report the unchanged test's result. Do not weaken tests to make CI pass.
- After every push or conflict resolution, inspect CI for the current PR head and its tested merge commit where applicable. Confirm workflow name and SHA; a previous head's green run or an unrelated workflow is not evidence for this revision. Report pending, skipped and unrun checks explicitly.
- Serialize heavy local jobs on this shared PC. Honour `C:\dev\lm\.heavy.lock` using the ownership, stale-check and refresh protocol in `C:\Users\Memory is RAM\Documents\projects\ReelWalk-rw\COMMON.md`; acquire per heavy command and release immediately afterward, including on failure. Never hold it while editing, using git or researching; do not overlap full checks/builds/renders.

Evidence and limits: [push/CI failure notes](docs/ci-push-failures.md).

# Verify sound before publishing

- Before posting or scheduling a reel on the user's account, verify the selected audio throughout the reel's full duration. A song title, catalogue metadata, waveform or successful preview download is not a listening check. If you cannot verify its contents, leave the reel as a draft and say so. Distinguish Instagram's supplied preview from the final server mix; never imply an unsupported music start offset will be honoured by auto-posting.
