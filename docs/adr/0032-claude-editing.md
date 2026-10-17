# 0032 - Claude for editing chat

The editing assistant uses the direct Anthropic Messages API with
`claude-opus-5-5`, the current Opus model verified against the official model
catalog on October 18, 2026. This lets eligible API requests use the owner's
Claude Console promotional credit instead of a separately billed intermediary.
The credit, its expiry and auto-reload setting remain provider-controlled.

The shared structured-answer adapter sends the existing JSON edit-plan schema,
handles image data for room labels and panorama aiming, and reports Claude's
model and token usage. Thinking blocks are not exposed as edit JSON. Refusals,
truncated answers and malformed output are rejected. The existing Zod plan
validation, owned-asset checks, allowed operations and undo behavior still apply.
There is no provider fallback when Anthropic is explicitly selected.

`AI_PROVIDER=anthropic`, `ANTHROPIC_MODEL=claude-opus-5-5` and the server-only
`ANTHROPIC_API_KEY` configure this path. Terraform defaults to Anthropic and puts
the key in encrypted SSM. Deployment must set the key before enabling this
configuration; an empty or `unset` placeholder disables real requests.
`AI_PROVIDER=openai` is an explicit rollback to the existing Responses transport.
Local fake editing remains available when no selected-provider key is configured.
Veo generation continues independently through Vertex AI.

Validation: six transport/guard tests, including a returned speed operation
applied to a native timeline; the existing 26 edit-plan tests; web typecheck;
focused ESLint; Terraform formatting. A real provider smoke test and production
activation require the dedicated workspace key. No secret is committed.

References:
- https://platform.claude.com/docs/en/models/opus-5-5/overview
- https://platform.claude.com/docs/en/build-with-claude/structured-outputs
