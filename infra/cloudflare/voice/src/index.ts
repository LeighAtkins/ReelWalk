/**
 * reelwalk-voice: the presenter's fixed voice (ADR 0038), as a Cloudflare
 * Worker with the Workers AI binding. The render worker POSTs a line and
 * gets MP3 back; the shared key is the only client. No API token is needed
 * for Workers AI this way, and the voice model is chosen here, once.
 *
 *   POST /  { "text": "Worth dropping in.", "voice": "melotts:en" | "aura-1:luna" }
 *   → audio/mpeg
 */

type Env = { AI: Ai; VOICE_KEY: string };

const MELO_LANGS = new Set(["en", "es", "fr", "jp", "kr", "zh"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST a line to speak.", { status: 405 });
    if (!env.VOICE_KEY || request.headers.get("x-voice-key") !== env.VOICE_KEY) return new Response("Unauthorised.", { status: 401 });
    let body: { text?: unknown; voice?: unknown };
    try { body = await request.json(); } catch { return new Response("Send JSON.", { status: 400 }); }
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length < 1 || text.length > 400) return new Response("text must be 1–400 characters.", { status: 400 });
    const [model = "melotts", option = ""] = (typeof body.voice === "string" ? body.voice : "melotts:en").split(":");
    try {
      if (model === "aura-1" || model === "aura-2") {
        const audio = await env.AI.run(`@cf/deepgram/${model}` as never, { text, speaker: option || "luna", encoding: "mp3" } as never) as ReadableStream | { audio?: string };
        return audioResponse(audio);
      }
      const lang = option.toLowerCase() || "en";
      if (!MELO_LANGS.has(lang)) return new Response(`Unknown MeloTTS language ${lang}.`, { status: 400 });
      const audio = await env.AI.run("@cf/myshell-ai/melotts", { prompt: text, lang } as never) as ReadableStream | { audio?: string };
      return audioResponse(audio);
    } catch (error) {
      return new Response(`The voice model failed: ${error instanceof Error ? error.message : "unknown"}`, { status: 502 });
    }
  },
};

/** Workers AI returns a stream for some models and base64 JSON for others; callers always get MP3 bytes. */
function audioResponse(audio: ReadableStream | { audio?: string }): Response {
  if (audio instanceof ReadableStream) return new Response(audio, { headers: { "content-type": "audio/mpeg" } });
  if (typeof audio?.audio === "string") return new Response(Uint8Array.from(atob(audio.audio), (c) => c.charCodeAt(0)), { headers: { "content-type": "audio/mpeg" } });
  return new Response("The voice model returned no audio.", { status: 502 });
}
