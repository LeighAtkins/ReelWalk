/**
 * A fixed presenter voice for AI takes (ADR 0038). Veo invents a new voice
 * on every take; the villa reel's two voiced takes were two different
 * women. Here the line is spoken by one configured text-to-speech voice on
 * Cloudflare Workers AI, and sync.so moves the presenter's mouth to it on
 * the silent Veo take. Veo's own audio stays available for shouted action
 * lines where lip sync will not hold.
 */

export type PresenterVoice = { model: "melotts"; lang: string } | { model: "aura-1" | "aura-2"; speaker: string };

export function voiceConfigured(): boolean {
  return process.env.VOICE_ENABLED === "true" && Boolean(process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_AI_TOKEN && process.env.SYNC_API_KEY);
}

/** PRESENTER_VOICE: "melotts:en" (default) or "aura-1:luna". The voice is the same for every take, which is the point. */
export function presenterVoice(value = process.env.PRESENTER_VOICE || "melotts:en"): PresenterVoice {
  const [model, option] = value.split(":");
  if (model === "aura-1" || model === "aura-2") return { model, speaker: option || "luna" };
  return { model: "melotts", lang: option || "en" };
}

/** The Workers AI request for a line in the configured voice. */
export function ttsRequest(voice: PresenterVoice, line: string, accountId: string): { url: string; body: Record<string, unknown> } {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/`;
  if (voice.model === "melotts") return { url: `${base}@cf/myshell-ai/melotts`, body: { prompt: line, lang: voice.lang } };
  return { url: `${base}@cf/deepgram/${voice.model}`, body: { text: line, speaker: voice.speaker, encoding: "mp3" } };
}

/** Workers AI answers with raw MP3 or with JSON carrying it base64; both become bytes. */
export async function ttsAudio(response: { headers: { get(name: string): string | null }; arrayBuffer(): Promise<ArrayBuffer>; json(): Promise<unknown> }): Promise<Buffer> {
  if ((response.headers.get("content-type") ?? "").startsWith("audio/")) return Buffer.from(await response.arrayBuffer());
  const data = await response.json() as { result?: { audio?: string }; audio?: string };
  const audio = data.result?.audio ?? data.audio;
  if (!audio) throw new Error("The voice service returned no audio.");
  return Buffer.from(audio, "base64");
}

export async function synthesiseLine(line: string): Promise<Buffer> {
  const request = ttsRequest(presenterVoice(), line, process.env.CLOUDFLARE_ACCOUNT_ID!);
  const response = await fetch(request.url, {
    method: "POST", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_AI_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(request.body), signal: AbortSignal.timeout(60_000),
  });
  // Never persist provider bodies: they may echo request data.
  if (!response.ok) throw new Error(`The voice service returned HTTP ${response.status}.`);
  const audio = await ttsAudio(response);
  if (audio.length < 100) throw new Error("The voice service returned no audio.");
  return audio;
}

/** The sync.so request: the silent take and the spoken line, by short-lived URL; "bounce" keeps the take's length. */
export function lipsyncRequest(videoUrl: string, audioUrl: string, model = process.env.LIPSYNC_MODEL || "lipsync-2") {
  return { model, input: [{ type: "video", url: videoUrl }, { type: "audio", url: audioUrl }], options: { sync_mode: "bounce" } };
}

const SYNC = "https://api.sync.so/v2/generate";
const syncHeaders = () => ({ "x-api-key": process.env.SYNC_API_KEY!, "Content-Type": "application/json" });

/** Starts a lip-sync generation; the idempotency key makes a retried start return the same job. */
export async function startLipsync(videoUrl: string, audioUrl: string, idempotencyKey: string): Promise<string> {
  const response = await fetch(SYNC, { method: "POST", headers: { ...syncHeaders(), "Idempotency-Key": idempotencyKey }, body: JSON.stringify(lipsyncRequest(videoUrl, audioUrl)), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`The lip-sync service returned HTTP ${response.status}.`);
  const data = await response.json() as { id?: string };
  if (!data.id) throw new Error("The lip-sync service did not return a job.");
  return data.id;
}

export type LipsyncStatus = { done: false } | { done: true; url: string } | { done: true; error: string };

export function lipsyncStatus(data: { status?: string; outputUrl?: string; error?: string }): LipsyncStatus {
  if (data.status === "COMPLETED" && data.outputUrl) return { done: true, url: data.outputUrl };
  if (data.status === "FAILED" || data.status === "REJECTED" || (data.status === "COMPLETED" && !data.outputUrl)) return { done: true, error: data.error || "The lip-sync service could not process this take." };
  return { done: false };
}

export async function pollLipsync(id: string): Promise<LipsyncStatus> {
  const response = await fetch(`${SYNC}/${encodeURIComponent(id)}`, { headers: syncHeaders(), signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`The lip-sync service returned HTTP ${response.status}.`);
  return lipsyncStatus(await response.json() as { status?: string; outputUrl?: string; error?: string });
}

/** Downloads a finished take from the lip-sync service's output URL. */
export async function fetchVideo(url: string): Promise<Buffer> {
  if (!/^https:\/\//.test(url)) throw new Error("Unexpected output location.");
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`The finished take could not be downloaded (HTTP ${response.status}).`);
  const video = Buffer.from(await response.arrayBuffer());
  if (video.length < 100 || video.length > 200 * 1024 * 1024) throw new Error("The finished take was unreadable.");
  return video;
}

/** How a spoken line is written into the Veo prompt for each voice mode. */
export function voicedPrompt(prompt: string, line: string, voice: "lipsync" | "veo"): string {
  return voice === "veo"
    ? `${prompt} She says aloud, clearly, in a warm Australian accent: "${line}". Her lips match the words.`
    : `${prompt} She is speaking these words to camera, mouth moving naturally with them, face clearly visible: "${line}". No other people speak.`;
}
