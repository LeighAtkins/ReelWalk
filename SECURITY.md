# Security

## Reporting a problem

Open a [private security advisory](https://github.com/LeighAtkins/ReelWalk/security/advisories/new)
rather than a public issue. ReelWalk is a one-person project, so expect a reply
within a few days.

## What finds problems

| Where | Tool | What it checks | Blocks a merge? |
| --- | --- | --- | --- |
| GitHub | Dependabot alerts | Known advisories in `pnpm-lock.yaml`, the Dockerfiles' base images and the Actions used | No, it opens alerts and PRs |
| GitHub | Dependabot version updates (`.github/dependabot.yml`) | Weekly PRs for npm, Docker base images and Actions, with Remotion, Prisma and the AWS SDK grouped | No |
| CI `verify` job | Trivy `fs` | The lockfile, HIGH and CRITICAL with a fix available | Yes |
| CI `verify` job | Trivy `config` | Dockerfiles, the Helm chart and Terraform, HIGH and CRITICAL | Yes |
| CI `images` job | Trivy `image` | The built web and worker images, HIGH and CRITICAL with a fix available | Yes |

## How a finding is sorted

Severity alone says how bad a bug is somewhere. What matters here is whether it
can be reached in ReelWalk, so every finding gets two questions:

1. **Does it ship?** Is the package in a production image (web or worker), or
   only in tests, the build or a local tool? `pnpm why -r <package>` shows the
   path; Dependabot's "development" scope is a hint, not proof.
2. **Can an attacker reach it?** Does untrusted input (an upload, a request, a
   caption) get to the vulnerable code, or only our own code and files?

| | Reachable from outside | Ships, not reachable | Dev and build only |
| --- | --- | --- | --- |
| **Critical / High** | Fix now, same day; take the service down if there is no fix | Fix within a week | Next weekly batch |
| **Medium / Low** | Fix within a week | Next weekly batch | Next weekly batch, or with the tool's next major |

"Fix" means upgrading, preferring the smallest version that contains the fix.
When the vulnerable copy cannot be upgraded (for example it is vendored inside
another package), the finding is **accepted** instead: it goes into
`.trivyignore.yaml` with a statement saying why it cannot be reached and what
would let us remove the entry. Accepted findings are re-read whenever the
package that holds them is upgraded, and entries whose code is gone are deleted.

## Record

### 2026-10-10: 15 Dependabot alerts, all fixed

All 15 came from test and build tooling (vitest 2.1 and 3.2 and what they pull
in). One package, `postcss-selector-parser`, also ships in the worker image.

| Advisory | Package | Severity | Ships? | Reachable? | Action |
| --- | --- | --- | --- | --- | --- |
| GHSA-5gmw-xhrv-c9v3, GHSA-85c8-ppgw-ccpr | tinypool 1.1.1 | Critical | No (vitest 2/3 worker pool) | No: options come from vitest | vitest 4.1.11 no longer uses tinypool |
| GHSA-5xrq-8626-4rwp | vitest < 3.2.6 | Critical | No | Only with `vitest --ui` listening; we never run it | vitest 4.1.11 |
| GHSA-82fw-gwwq-j7x9 | vitest, @vitest/mocker < 4.1.11 | Medium | No | No: needs a malicious test file | vitest 4.1.11 |
| GHSA-fx2h-pf6j-xcff | vite <= 6.4.2 | High | No (dev server only) | Only on Windows, with the dev server exposed | vite 6.4.3 (vite 5 removed with vitest 2) |
| GHSA-4w7w-66w2-5vf9, GHSA-v6wh-96g9-6wx3 | vite <= 6.4.2 | Medium | No | Dev server only | vite 6.4.3 |
| GHSA-67mh-4wv8-2f99 | esbuild <= 0.24.2 | Medium | No | Dev server only | Removed with vite 5 |
| GHSA-rj75-hqrm-r3gf | postcss-selector-parser 7.1.4 | Medium | Yes: worker, via `@remotion/bundler` → `css-loader` | No: it only parses ReelWalk's own CSS when a render bundles the composition | pnpm override to `^7.1.6` |

Checks after the change: all unit suites pass on vitest 4, and Trivy reports no
vulnerabilities in the lockfile at any severity.

Also in this batch, `.trivyignore.yaml` was cleaned up:

- **Removed:** AWS-0040 and AWS-0041 (public EKS API endpoint). The cluster and
  its Terraform were destroyed on 2026-10-07.
- **Removed:** DS-0002 for `apps/worker/Dockerfile.b4chrome`. The unused file
  was deleted instead of being excused.
- **Rewritten:** AWS-0104 and AWS-0164 still apply, but now to the Fargate
  render worker rather than EKS nodes.
- **Still accepted:** the tinypool copy vendored inside `@rspack/core` (image
  scan), with its exit condition.

### Open, by choice

The Dependabot PRs for major versions (TypeScript 6, Vite 8, Vitest 5, React
DOM, the Remotion group, Node 25/26 base images) are not security fixes. Each
needs its own test run, and the Node 26 images fail because they no longer ship
corepack. They wait for a quiet week rather than being merged in bulk.
