"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { EDGES, NODES, ROUTES, type MapNode, type Route } from "@/content/map";
import type { Line } from "@/lib/types";
import { currentGeneration, speakNext, stop, wait } from "@/lib/speech";
import { useSettings } from "@/lib/settings";
import { useLocal } from "@/lib/store";
import { Ja } from "./Ja";
import { Speak, PlayIcon, StopIcon } from "./Speak";

export interface NodeInfo {
  name: string;
  oneLiner: Line;
}

type Env = "aws" | "local";
const byId = new Map(NODES.map((n) => [n.id, n]));

function pathBetween(a: string, b: string): [number, number][] {
  const A = byId.get(a)!;
  const B = byId.get(b)!;
  const fwd = EDGES.find((e) => e.a === a && e.b === b);
  const rev = EDGES.find((e) => e.a === b && e.b === a);
  const via = fwd?.via ?? (rev?.via ? [...rev.via].reverse() : []);
  return [[A.x, A.y], ...via, [B.x, B.y]];
}

function toD(points: [number, number][]) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");
}

export function SystemMap({ info }: { info: Record<string, NodeInfo> }) {
  const [env, setEnv] = useLocal<Env>("map-env", "aws");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [s] = useSettings();
  const panel = useRef<HTMLDivElement>(null);

  const route: Route | undefined = ROUTES.find((r) => r.id === routeId);
  const current = route ? route.stops[step] : undefined;
  const onRoute = useMemo(() => new Set(route?.stops.map((st) => st.at)), [route]);
  const trainNode = current ? byId.get(current.at) : undefined;

  useEffect(() => () => stop(), []);

  // Keep the moving stop on screen while the narration panel covers the bottom.
  useEffect(() => {
    if (!current) return;
    const el = document.querySelector<SVGGElement>(`[data-node="${current.at}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [current]);

  function chooseRoute(id: string | null) {
    stop();
    setPlaying(false);
    setRouteId(id);
    setStep(0);
    setSelected(null);
  }

  function go(n: number) {
    if (!route) return;
    stop();
    setPlaying(false);
    setStep(Math.max(0, Math.min(route.stops.length - 1, n)));
  }

  async function playRoute() {
    if (!route) return;
    stop();
    const gen = currentGeneration();
    setPlaying(true);
    for (let i = step; i < route.stops.length; i++) {
      setStep(i);
      const st = route.stops[i];
      for (const l of [st.line, ...(st.more ?? [])]) {
        if (!(await speakNext(l.ja, { rate: s.rate, voiceURI: s.voiceURI }, gen))) return setPlaying(false);
        if (!(await wait(350, gen))) return setPlaying(false);
      }
      if (!(await wait(500, gen))) return setPlaying(false);
    }
    setPlaying(false);
  }

  function tapNode(n: MapNode) {
    if (route) {
      const idx = route.stops.findIndex((st, i) => st.at === n.id && i >= step);
      const any = idx >= 0 ? idx : route.stops.findIndex((st) => st.at === n.id);
      if (any >= 0) go(any);
      return;
    }
    setSelected(n.id === selected ? null : n.id);
    requestAnimationFrame(() => panel.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
  }

  const sel = selected ? byId.get(selected) : undefined;
  const selInfo = sel ? info[sel.topic] : undefined;

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="route-picker" role="group" aria-label="Follow a route">
        <button type="button" aria-pressed={routeId === null} onClick={() => chooseRoute(null)} style={{ "--c": "#18202b" } as React.CSSProperties}>
          Whole system
        </button>
        {ROUTES.map((r) => (
          <button key={r.id} type="button" aria-pressed={routeId === r.id} onClick={() => chooseRoute(r.id)} style={{ "--c": r.color } as React.CSSProperties}>
            <Ja text={r.title.ja} />
          </button>
        ))}
      </div>

      {route && <p className="note">{route.summary}</p>}

      <div className="map-wrap">
        <svg className="map" viewBox="0 0 360 650" role="img" aria-label="ReelWalk system map">
          <rect className="zone" x="120" y="96" width="232" height="356" rx="16" />
          <text className="zone-label" x="344" y="114" textAnchor="end">
            {env === "aws" ? "EKS cluster" : "kind / Compose"}
          </text>
          <rect className="zone" x="8" y="572" width="344" height="72" rx="16" />

          {EDGES.map((e) => (
            <path key={`${e.a}-${e.b}`} className="edge" d={toD(pathBetween(e.a, e.b))} />
          ))}

          {route &&
            route.stops.slice(1).map((st, i) => {
              const from = route.stops[i].at;
              if (from === st.at) return null;
              const done = i < step;
              return (
                <path
                  key={i}
                  className="route"
                  d={toD(pathBetween(from, st.at))}
                  stroke={route.color}
                  opacity={done ? 1 : 0.22}
                />
              );
            })}

          {NODES.map((n) => {
            const dim = route && !onRoute.has(n.id);
            const active = (route && current?.at === n.id) || (!route && selected === n.id);
            const label = n.name[env];
            return (
              <g
                key={n.id}
                data-node={n.id}
                className="node"
                data-dim={dim || undefined}
                data-active={active || undefined}
                onClick={() => tapNode(n)}
                role="button"
                tabIndex={0}
                aria-label={label}
                onKeyDown={(ev) => (ev.key === "Enter" || ev.key === " ") && tapNode(n)}
              >
                <circle cx={n.x} cy={n.y} r="22" fill="transparent" />
                <circle className="ring" cx={n.x} cy={n.y} r="13" stroke={n.color} />
                <text className="node-code" x={n.x} y={n.y}>
                  {n.code}
                </text>
                <text className="node-name" x={n.x} y={n.y + 30} textAnchor="middle">
                  {label}
                </text>
                <text className="node-sub" x={n.x} y={n.y + 44} textAnchor="middle">
                  {n.sub.replace(/\{[^}]*\}/g, "")}
                </text>
              </g>
            );
          })}

          {trainNode && route && (
            <g className="train" style={{ transform: `translate(${trainNode.x}px, ${trainNode.y}px)` }}>
              <circle r="19" fill="none" stroke={route.color} strokeWidth="4" opacity="0.5">
                <animate attributeName="r" values="15;24;15" dur="1.6s" repeatCount="indefinite" />
              </circle>
            </g>
          )}
        </svg>
      </div>

      <div className="env-toggle">
        <span className="note">Show names for</span>
        <div className="seg">
          <button type="button" aria-pressed={env === "aws"} onClick={() => setEnv("aws")}>
            AWS design
          </button>
          <button type="button" aria-pressed={env === "local"} onClick={() => setEnv("local")}>
            What runs locally
          </button>
        </div>
      </div>

      <div ref={panel} className={route ? "panel-sticky" : undefined}>
        {route && current ? (
          <div className="stepper" style={{ "--c": route.color } as React.CSSProperties}>
            <div className="stepper-top">
              <span className="step-count">
                Stop {step + 1} of {route.stops.length}
              </span>
              <span className="step-where">{byId.get(current.at)?.name[env]}</span>
            </div>
            <StopLines lines={[current.line, ...(current.more ?? [])]} />
            <div className="stepper-nav">
              <button type="button" className="btn" onClick={() => go(step - 1)} disabled={step === 0}>
                ‹ Back
              </button>
              {playing ? (
                <button type="button" className="btn btn-ink" onClick={() => { stop(); setPlaying(false); }}>
                  <StopIcon /> Stop
                </button>
              ) : (
                <button type="button" className="btn btn-ink" onClick={playRoute}>
                  <PlayIcon /> Narrate
                </button>
              )}
              <button type="button" className="btn" onClick={() => go(step + 1)} disabled={step === route.stops.length - 1}>
                Next ›
              </button>
            </div>
          </div>
        ) : sel && selInfo ? (
          <div className="block stack" style={{ gap: 10 }}>
            <div className="node-sheet-top">
              <h2>{selInfo.name}</h2>
              <span className="note" lang="ja">
                <Ja text={sel.sub} />
              </span>
            </div>
            <StopLines lines={[selInfo.oneLiner]} />
            <Link className="btn btn-ink" href={`/topics/${sel.topic}/`} style={{ alignSelf: "flex-start" }}>
              Open the {selInfo.name} lesson
            </Link>
          </div>
        ) : (
          <p className="note">Tap a station to hear what it does, or pick a route above to follow a request through the system.</p>
        )}
      </div>
    </div>
  );
}

function StopLines({ lines }: { lines: Line[] }) {
  return (
    <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {lines.map((l, i) => (
        <li key={i} className="line" style={{ borderBottom: i === lines.length - 1 ? 0 : undefined }}>
          <Speak text={l.ja} size={i === 0 ? "md" : "sm"} />
          <div className="line-body">
            <p className="ja-line" style={i ? { fontSize: 17 } : undefined}>
              <Ja text={l.ja} />
            </p>
            <p className="en-line">{l.en}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}
