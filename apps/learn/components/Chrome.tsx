"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useSettings } from "@/lib/settings";
import { japaneseVoices, onVoicesChanged, speak, supported } from "@/lib/speech";
import { Ja } from "./Ja";
import { VOICES, VOICE_TEST } from "@/content/misc";

const TABS = [
  { href: "/", ja: "今日", en: "Today", match: (p: string) => p === "/" },
  { href: "/map/", ja: "路線図", en: "Map", match: (p: string) => p.startsWith("/map") },
  { href: "/topics/", ja: "学ぶ", en: "Learn", match: (p: string) => p.startsWith("/topics") },
  { href: "/practice/", ja: "面接", en: "Interview", match: (p: string) => p.startsWith("/practice") || p.startsWith("/phrases") },
  { href: "/words/", ja: "単語", en: "Words", match: (p: string) => p.startsWith("/words") },
  { href: "/listen/", ja: "聞く", en: "Listen", match: (p: string) => p.startsWith("/listen") },
];

function strip(path: string) {
  const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
  return base && path.startsWith(base) ? path.slice(base.length) || "/" : path;
}

export function TabBar() {
  const path = strip(usePathname() ?? "/");
  return (
    <nav className="tabbar" aria-label="Sections">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className="tab" aria-current={t.match(path) ? "page" : undefined}>
          <span lang="ja" className="tab-ja">{t.ja}</span>
          <span className="tab-en">{t.en}</span>
        </Link>
      ))}
    </nav>
  );
}

export function TopBar() {
  const [s, patch] = useSettings();
  const [open, setOpen] = useState(false);
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          ReelWalk <span lang="ja">面接ノート</span>
        </Link>
        <div className="topbar-tools">
          <button type="button" className="chip" aria-pressed={s.furigana} onClick={() => patch({ furigana: !s.furigana })}>
            <ruby>振<rt>ふり</rt></ruby>
            <span className="sr">Furigana</span>
          </button>
          <button type="button" className="chip" aria-pressed={s.english === "show"} onClick={() => patch({ english: s.english === "show" ? "tap" : "show" })}>
            EN
            <span className="sr">English always shown</span>
          </button>
          <button type="button" className="chip" onClick={() => setOpen(true)} aria-label="Voice and speed">
            {s.rate.toFixed(2).replace(/0$/, "")}×
          </button>
        </div>
      </header>
      {open && <VoiceSheet onClose={() => setOpen(false)} />}
    </>
  );
}

const RATES = [0.6, 0.75, 0.9, 1, 1.15];

function VoiceSheet({ onClose }: { onClose: () => void }) {
  const [s, patch] = useSettings();
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  useEffect(() => {
    const load = () => setVoices(japaneseVoices());
    load();
    return onVoicesChanged(load);
  }, []);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" role="dialog" aria-label="Voice and speed" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>Voice and speed</h2>
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
        <p className="label">Speed</p>
        <div className="seg">
          {RATES.map((r) => (
            <button key={r} type="button" aria-pressed={s.rate === r} onClick={() => patch({ rate: r })}>
              {r}×
            </button>
          ))}
        </div>
        <p className="label">Voice</p>
        <div className="voices">
          {VOICES.map((v) => (
            <button key={v.id} type="button" aria-pressed={s.voiceSource === v.id} onClick={() => patch({ voiceSource: v.id })}>
              {v.label} <span className="note">({v.credit})</span>
            </button>
          ))}
          <button type="button" aria-pressed={s.voiceSource === "device"} onClick={() => patch({ voiceSource: "device" })}>
            This device's own voice
          </button>
        </div>
        <p className="note">
          Recorded voices work on any phone, offline once loaded. Readings follow the furigana, so pitch accent can occasionally be off; check new words against a
          dictionary or a native speaker.
        </p>
        {s.voiceSource !== "device" ? null : !supported() ? (
          <p className="note">This browser has no speech engine. Safari on iPhone and Chrome on Android both have one.</p>
        ) : voices.length === 0 ? (
          <p className="note">
            No Japanese voice found. On iPhone: Settings › Accessibility › Spoken Content › Voices › Japanese. On Android: install Japanese in Google
            Speech Services.
          </p>
        ) : (
          <div className="voices">
            <button type="button" aria-pressed={s.voiceURI === null} onClick={() => patch({ voiceURI: null })}>
              Best available
            </button>
            {voices.map((v) => (
              <button key={v.voiceURI} type="button" aria-pressed={s.voiceURI === v.voiceURI} onClick={() => patch({ voiceURI: v.voiceURI })}>
                {v.name}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className="btn btn-ink test"
          onClick={() => speak(VOICE_TEST.ja, { rate: s.rate, voiceURI: s.voiceURI })}
        >
          Test: <Ja text="冪等性{べきとうせい}を意識{いしき}して設計{せっけい}しました" />
        </button>
      </div>
    </div>
  );
}
