"use client";

import { toSpeech } from "./ruby";

/**
 * Japanese text-to-speech through the browser's Web Speech API.
 * Phones ship good Japanese voices (iOS: Kyoko/O-ren, Android: Google 日本語),
 * so this needs no server and works offline once the page is loaded.
 */

const PREFERRED = [/nanami/i, /google.*日本語/i, /kyoko/i, /o-?ren/i, /otoya/i, /haruka/i, /ayumi/i];

export function supported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function japaneseVoices(): SpeechSynthesisVoice[] {
  if (!supported()) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.replace("_", "-").toLowerCase().startsWith("ja"));
}

export function pickVoice(voiceURI: string | null): SpeechSynthesisVoice | undefined {
  const voices = japaneseVoices();
  if (voiceURI) {
    const chosen = voices.find((v) => v.voiceURI === voiceURI);
    if (chosen) return chosen;
  }
  for (const re of PREFERRED) {
    const v = voices.find((x) => re.test(x.name));
    if (v) return v;
  }
  return voices[0];
}

/** Calls back when the voice list arrives (Chrome loads it asynchronously). */
export function onVoicesChanged(cb: () => void): () => void {
  if (!supported()) return () => {};
  window.speechSynthesis.addEventListener("voiceschanged", cb);
  return () => window.speechSynthesis.removeEventListener("voiceschanged", cb);
}

// Chrome drops `end` events for utterances that get garbage-collected mid-speech.
const live = new Set<SpeechSynthesisUtterance>();
let generation = 0;

export interface SpeakOptions {
  rate: number;
  voiceURI: string | null;
  /** Language override; JA markup is converted to readings unless lang is English. */
  lang?: "ja-JP" | "en-US";
}

/** Speaks one piece of text, cancelling anything already playing. Resolves when done or stopped. */
export function speak(text: string, opts: SpeakOptions): Promise<boolean> {
  stop();
  return enqueue(text, opts, generation);
}

function enqueue(text: string, opts: SpeakOptions, gen: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!supported() || gen !== generation) return resolve(false);
    const lang = opts.lang ?? "ja-JP";
    const u = new SpeechSynthesisUtterance(lang === "ja-JP" ? toSpeech(text) : text);
    u.lang = lang;
    u.rate = opts.rate;
    if (lang === "ja-JP") {
      const voice = pickVoice(opts.voiceURI);
      if (voice) u.voice = voice;
    }
    live.add(u);
    const done = (ok: boolean) => {
      live.delete(u);
      resolve(ok && gen === generation);
    };
    u.onend = () => done(true);
    u.onerror = () => done(false);
    window.speechSynthesis.speak(u);
  });
}

export function stop(): void {
  generation++;
  if (supported()) window.speechSynthesis.cancel();
}

/** The current playback generation; a playlist stops when it changes. */
export function currentGeneration(): number {
  return generation;
}

export function wait(ms: number, gen: number): Promise<boolean> {
  return new Promise((resolve) => setTimeout(() => resolve(gen === generation), ms));
}

/** Speaks without cancelling first, for playlists that own the current generation. */
export function speakNext(text: string, opts: SpeakOptions, gen: number): Promise<boolean> {
  return enqueue(text, opts, gen);
}

/** A rough time a learner needs to repeat a line aloud. */
export function shadowGap(text: string, rate: number): number {
  return Math.round(toSpeech(text).length * (190 / rate)) + 900;
}
