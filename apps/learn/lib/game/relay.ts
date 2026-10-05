"use client";

/**
 * Two phones talk through ntfy.sh, a public pub/sub relay: POST publishes a
 * message to a topic, an EventSource on the topic receives them. No account,
 * CORS enabled, and recent messages are replayed on connect, so a phone that
 * joins late (or reloads) catches up. The room code is the private part of
 * the topic name; only game moves are sent, never personal data.
 */

const RELAY = "https://ntfy.sh";
const ALPHABET = "ACDEFHJKMNPRTUVWXY34679";

export function newRoomCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join("");
}

export function normaliseCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

const topic = (room: string) => `reelwalk-mensetsu-${room.toLowerCase()}`;

export type Sender = "host" | "cand";

export interface Envelope<T> {
  from: Sender;
  body: T;
}

export async function publish<T>(room: string, from: Sender, body: T): Promise<void> {
  const payload = JSON.stringify({ from, body } satisfies Envelope<T>);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${RELAY}/${topic(room)}`, { method: "POST", body: payload });
      if (r.ok) return;
    } catch {
      // Retried below.
    }
    await new Promise((res) => setTimeout(res, 600 * (attempt + 1)));
  }
  throw new Error("Could not reach the relay");
}

export type Status = "connecting" | "live" | "offline";

/**
 * Subscribes to a room. `since` is "all" to replay recent history, or a Unix
 * time in seconds. Messages are deduplicated by relay id, so reconnects that
 * replay history don't deliver anything twice.
 */
export function subscribe<T>(
  room: string,
  since: "all" | number,
  onMessage: (e: Envelope<T>) => void,
  onStatus: (s: Status) => void,
): () => void {
  const seen = new Set<string>();
  const es = new EventSource(`${RELAY}/${topic(room)}/sse?since=${since}`);
  onStatus("connecting");
  es.onopen = () => onStatus("live");
  es.onerror = () => onStatus(es.readyState === EventSource.CLOSED ? "offline" : "connecting");
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data) as { id: string; event: string; message?: string };
      if (msg.event !== "message" || !msg.message || seen.has(msg.id)) return;
      seen.add(msg.id);
      onMessage(JSON.parse(msg.message) as Envelope<T>);
    } catch {
      // Not one of ours.
    }
  };
  return () => es.close();
}
