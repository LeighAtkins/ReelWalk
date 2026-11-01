# Personal owner connector limits

The connector's per-user call/write and hourly tool caps remain enabled for customers.
A connected user is exempt only when all of the following server-side facts hold:

- Their checked workspace role is OWNER.
- The connection is bound to their home workspace.
- That workspace has the explicitly provisioned `owner-personal-lifetime:<workspaceId>` credit grant, with kind OWNER and no expiry.

The marker is provisioned by operations, never from MCP input. Removing it revokes the exemption on the next call. This does not bypass authentication, OAuth scopes, workspace membership, AI-off controls, native credit reservations, idempotency, provider budgets, or the worker queue. It does not enable paid Claude overage or charge a payment card.

The owner requested this exemption after the connector's ten-AI-calls-per-hour counter prevented finalizing an otherwise completed private reel. Production counters were cleared once for that owner's MCP keys to unblock the current task while this change ships; login and other users' counters were untouched.
