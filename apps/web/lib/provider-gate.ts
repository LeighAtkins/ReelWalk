import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The point right before a paid AI provider request and right after its
 * answer arrives (ADR 0049). The durable worker runs a step inside a gate:
 * the first request records the submission under the step's lease (and
 * throws, sending nothing, if the lease was lost or the run was stopped);
 * an answer of any kind marks the request as no longer in doubt. Outside a
 * gate (the in-process path, other callers) both are no-ops.
 */
export type ProviderGate = {
  beforeRequest(): Promise<void>;
  answered(): void;
  /** Aborted when the attempt is given up (its deadline): in-flight requests are cancelled and no new one starts. */
  signal?: AbortSignal;
};

const gates = new AsyncLocalStorage<ProviderGate>();

export function withProviderGate<T>(gate: ProviderGate, work: () => Promise<T>): Promise<T> {
  return gates.run(gate, work);
}

export async function beforeProviderRequest(): Promise<void> {
  const gate = gates.getStore();
  gate?.signal?.throwIfAborted();
  await gate?.beforeRequest();
}

/**
 * Inside a gate a request that got no answer must not be sent again by the
 * step's own code: that would be a second paid submission in the same
 * attempt. Callers that retry transient failures check this first.
 */
export function insideProviderGate(): boolean {
  return gates.getStore() !== undefined;
}

/** The request's own signal, combined with the gate's, so giving up an attempt cancels its requests. */
export function providerSignal(own: AbortSignal): AbortSignal {
  const gate = gates.getStore()?.signal;
  return gate ? AbortSignal.any([own, gate]) : own;
}

export function providerAnswered(): void {
  gates.getStore()?.answered();
}
