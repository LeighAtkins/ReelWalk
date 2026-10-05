"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useLocal } from "@/lib/store";

interface Task {
  id: string;
  text: string;
  href: string;
}

interface Day {
  date: string;
  kanji: string;
  title: string;
  tasks: Task[];
}

const INTERVIEW = "2026-10-08";

const DAYS: Day[] = [
  {
    date: "2026-10-05",
    kanji: "月",
    title: "See the whole system",
    tasks: [
      { id: "mon-map", text: "Follow all four routes on the map, with narration", href: "/map/" },
      { id: "mon-30", text: "Say the 30-second ReelWalk pitch aloud three times", href: "/practice/reelwalk-30/" },
      { id: "mon-words", text: "Clear one round of flashcards from the Queue line", href: "/words/?line=async" },
      { id: "mon-scope", text: "Learn the honest-scope answer: designed for AWS, verified locally", href: "/practice/honest-scope/" },
    ],
  },
  {
    date: "2026-10-06",
    kanji: "火",
    title: "Reliability and the platform",
    tasks: [
      { id: "tue-queue", text: "Lessons: SQS, worker, idempotency, retries and DLQ", href: "/topics/sqs/" },
      { id: "tue-k8s", text: "Lessons: Docker, Kubernetes, Helm, GitHub Actions, Trivy", href: "/topics/docker/" },
      { id: "tue-90", text: "Shadow the 90-second explanation until it flows", href: "/practice/reelwalk-90/" },
      { id: "tue-phrases", text: "Phrases for asking again and buying time", href: "/phrases/" },
    ],
  },
  {
    date: "2026-10-07",
    kanji: "水",
    title: "Mock interview day",
    tasks: [
      { id: "wed-fill", text: "Fill in the 【】 parts of your self-introduction and motivation", href: "/practice/self-intro/" },
      { id: "wed-drill", text: "Drill 20 questions, recording each answer", href: "/drill/" },
      { id: "wed-3min", text: "Give the 3-minute walkthrough with Japanese hidden", href: "/practice/reelwalk-3min/" },
      { id: "wed-watch", text: "Watch two interview videos by native speakers", href: "/listen/#videos" },
    ],
  },
  {
    date: "2026-10-08",
    kanji: "木",
    title: "Interview day",
    tasks: [
      { id: "thu-listen", text: "On the way: listen to your self-introduction and the 90-second pitch", href: "/listen/" },
      { id: "thu-ask", text: "Pick two questions to ask them", href: "/practice/#ask" },
      { id: "thu-trouble", text: "Glance at the phrases for online-call trouble", href: "/phrases/" },
    ],
  },
];

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Countdown() {
  const [days, setDays] = useState<number | null>(null);
  useEffect(() => {
    const ms = new Date(`${INTERVIEW}T00:00:00`).getTime() - new Date(`${todayISO()}T00:00:00`).getTime();
    setDays(Math.round(ms / 86400000));
  }, []);
  if (days === null) return <p className="countdown">&nbsp;</p>;
  if (days > 0) return <p className="countdown">面接まであと{days}日 · {days} {days === 1 ? "day" : "days"} to the interview</p>;
  if (days === 0) return <p className="countdown">今日は面接の日です。がんばってください。</p>;
  return <p className="countdown">面接、お疲れさまでした。</p>;
}

export function Plan() {
  const [done, setDone] = useLocal<Record<string, boolean>>("plan", {});
  const [today, setToday] = useState("");
  useEffect(() => setToday(todayISO()), []);

  return (
    <ol className="days">
      {DAYS.map((d) => {
        const isToday = d.date === today || (today && today < DAYS[0].date && d === DAYS[0]);
        const past = today !== "" && d.date < today && today <= INTERVIEW;
        const md = `${Number(d.date.slice(5, 7))}月${Number(d.date.slice(8))}日`;
        return (
          <li key={d.date} className="day" data-today={isToday || undefined} data-past={past || undefined}>
            <span className="day-badge" lang="ja" aria-hidden="true">
              {d.kanji}
            </span>
            <div className="day-body">
              <p className="day-date" lang="ja">
                {md}
                {isToday ? " · 今日" : ""}
              </p>
              <h3>{d.title}</h3>
              <ul className="tasks">
                {d.tasks.map((t) => (
                  <li key={t.id} className="task" data-done={done[t.id] || undefined}>
                    <input
                      type="checkbox"
                      checked={!!done[t.id]}
                      onChange={(e) => setDone((prev) => ({ ...prev, [t.id]: e.target.checked }))}
                      aria-label={`Done: ${t.text}`}
                    />
                    <Link href={t.href}>{t.text}</Link>
                  </li>
                ))}
              </ul>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
