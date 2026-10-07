/* global console, process, URL */
/**
 * Builds the English study guide (PDF) and the briefing for a voice
 * interview agent (XML) from the site's content, into public/guide/.
 *   node scripts/study-guide.mts
 * The PDF is printed by Playwright's Chromium (installed for the e2e tests).
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appTopics } from "../content/topics-app.ts";
import { asyncTopics } from "../content/topics-async.ts";
import { platformTopics } from "../content/topics-platform.ts";
import { company, generalQA, scripts } from "../content/interview.ts";
import { EDGES, NODES, ROUTES, type Route } from "../content/map.ts";
import { DECISIONS } from "../content/decisions.ts";
import { toPlain } from "../lib/ruby.ts";
import type { Group, Topic } from "../lib/types.ts";

const outDir = fileURLToPath(new URL("../public/guide/", import.meta.url));
const fontUrl = pathToFileURL(
  fileURLToPath(new URL("../node_modules/@fontsource-variable/archivo/files/archivo-latin-wdth-normal.woff2", import.meta.url)),
).href;

const GROUP_ORDER: Group[] = ["app", "data", "async", "platform", "delivery", "quality", "aws"];
const GROUPS: Record<Group, { en: string; color: string }> = {
  app: { en: "App", color: "#0079C2" },
  data: { en: "Data", color: "#8F5BB5" },
  async: { en: "Queue and render", color: "#E2407F" },
  platform: { en: "Platform", color: "#00A3D9" },
  delivery: { en: "CI/CD", color: "#00994C" },
  quality: { en: "Testing and security", color: "#EE8A00" },
  aws: { en: "AWS", color: "#9A7B2F" },
};
const STATUS = {
  built: "Built and running",
  local: "Runs locally with a stand-in",
  designed: "Designed, not deployed",
} as const;

const topics: Topic[] = [...appTopics, ...asyncTopics, ...platformTopics].sort(
  (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
);
const script = (id: string) => scripts.find((s) => s.id === id);
const en = (lines: { en: string }[]) => lines.map((l) => l.en).join(" ");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- diagrams

const ROLE: Record<string, string> = {
  browser: "the user's phone",
  ingress: "entry point",
  web: "pages + Server Actions",
  postgres: "source of truth",
  sqs: "work queue",
  dlq: "failed messages",
  s3: "media files",
  worker: "renders MP4s",
  cloudfront: "video delivery",
  actions: "CI",
  trivy: "scans",
  registry: "images",
  argocd: "GitOps sync",
  cluster: "runs pods",
};

const byId = new Map(NODES.map((n) => [n.id, n]));

function pathBetween(a: string, b: string): [number, number][] {
  const A = byId.get(a)!;
  const B = byId.get(b)!;
  const fwd = EDGES.find((e) => e.a === a && e.b === b);
  const rev = EDGES.find((e) => e.a === b && e.b === a);
  const via = fwd?.via ?? (rev?.via ? [...rev.via].reverse() : []);
  return [[A.x, A.y], ...via, [B.x, B.y]];
}
const d = (pts: [number, number][]) => pts.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ");

function systemSvg(route?: Route): string {
  const onRoute = new Set(route?.stops.map((s) => s.at));
  const numbers = new Map<string, number[]>();
  route?.stops.forEach((s, i) => numbers.set(s.at, [...(numbers.get(s.at) ?? []), i + 1]));
  const parts: string[] = [];
  parts.push(`<rect x="120" y="96" width="232" height="356" rx="16" class="zone"/>`);
  parts.push(`<text x="352" y="90" text-anchor="end" class="zl">Kubernetes cluster</text>`);
  parts.push(`<rect x="8" y="572" width="344" height="72" rx="16" class="zone"/>`);
  for (const e of EDGES) parts.push(`<path d="${d(pathBetween(e.a, e.b))}" class="edge"/>`);
  if (route)
    route.stops.slice(1).forEach((s, i) => {
      const from = route.stops[i].at;
      if (from !== s.at) parts.push(`<path d="${d(pathBetween(from, s.at))}" class="route" stroke="${route.color}"/>`);
    });
  for (const n of NODES) {
    const dim = route && !onRoute.has(n.id) ? ` opacity="0.3"` : "";
    parts.push(`<g${dim}>
      <circle cx="${n.x}" cy="${n.y}" r="13" fill="#fff" stroke="${n.color}" stroke-width="6"/>
      <text x="${n.x}" y="${n.y + 30}" text-anchor="middle" class="nn">${esc(n.name.aws)}</text>
      <text x="${n.x}" y="${n.y + 43}" text-anchor="middle" class="ns">${esc(ROLE[n.id] ?? "")}</text>
      ${n.name.local !== n.name.aws ? `<text x="${n.x}" y="${n.y + 55}" text-anchor="middle" class="nl">local: ${esc(n.name.local)}</text>` : ""}
    </g>`);
    const nums = numbers.get(n.id);
    if (route && nums)
      nums.forEach((k, j) => {
        const x = n.x - 14 + j * 15 - ((nums.length - 1) * 15) / 2 + 14;
        parts.push(`<circle cx="${x}" cy="${n.y - 22}" r="7.5" fill="${route.color}"/><text x="${x}" y="${n.y - 19}" text-anchor="middle" class="num">${k}</text>`);
      });
  }
  return `<svg viewBox="0 0 360 662" class="diagram tall">${parts.join("")}</svg>`;
}

function stateSvg(): string {
  const box = (x: number, y: number, label: string, color: string) =>
    `<rect x="${x}" y="${y}" width="120" height="40" rx="10" fill="#fff" stroke="${color}" stroke-width="3"/><text x="${x + 60}" y="${y + 25}" text-anchor="middle" class="st">${label}</text>`;
  const arrow = (p: string, label: string, lx: number, ly: number) =>
    `<path d="${p}" class="arrow" marker-end="url(#ah)"/><text x="${lx}" y="${ly}" class="al">${label}</text>`;
  return `<svg viewBox="0 0 640 300" class="diagram">
    <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#18202b"/></marker></defs>
    ${box(40, 130, "QUEUED", "#0079C2")}
    ${box(260, 130, "RUNNING", "#E2407F")}
    ${box(480, 50, "SUCCEEDED", "#00994C")}
    ${box(480, 210, "FAILED", "#EE8A00")}
    ${arrow("M160 142 L258 142", "worker claims", 172, 132)}
    ${arrow("M260 162 L162 162", "attempt failed: retry with backoff", 140, 186)}
    ${arrow("M380 140 L478 78", "output uploaded", 392, 96)}
    ${arrow("M380 160 L478 222", "attempts exhausted", 400, 212)}
    ${arrow("M100 172 C100 290 420 290 478 240", "dead-lettered", 180, 282)}
    ${arrow("M540 210 C540 20 120 20 100 128", "manual retry (generation + 1)", 220, 30)}
  </svg>`;
}

function pipelineSvg(): string {
  const steps: [string, string, string][] = [
    ["Push / PR", "GitHub", "#18202b"],
    ["Lint, typecheck, unit tests", "Turborepo + Vitest", "#00994C"],
    ["Helm lint + config scan", "Trivy", "#EE8A00"],
    ["Build images", "Docker", "#00A3D9"],
    ["Scan images", "Trivy", "#EE8A00"],
    ["End-to-end tests", "Playwright, real render", "#EE8A00"],
    ["Push images (main)", "GHCR, tag = commit SHA", "#00A3D9"],
    ["Commit new tag to Git", "values file", "#00994C"],
    ["Sync the cluster", "Argo CD → kind", "#00994C"],
  ];
  const parts = steps.map(([t, s, c], i) => {
    const row = Math.floor(i / 3);
    const col = row % 2 === 0 ? i % 3 : 2 - (i % 3);
    const x = 10 + col * 210;
    const y = 10 + row * 90;
    return `<rect x="${x}" y="${y}" width="190" height="58" rx="10" fill="#fff" stroke="${c}" stroke-width="3"/>
      <text x="${x + 12}" y="${y + 24}" class="pt">${i + 1}. ${esc(t)}</text><text x="${x + 12}" y="${y + 44}" class="ps">${esc(s)}</text>`;
  });
  const arrows = steps.slice(1).map((_, i) => {
    const a = i;
    const b = i + 1;
    const pos = (k: number) => {
      const row = Math.floor(k / 3);
      const col = row % 2 === 0 ? k % 3 : 2 - (k % 3);
      return { x: 10 + col * 210, y: 10 + row * 90, row };
    };
    const A = pos(a);
    const B = pos(b);
    if (A.row !== B.row) return `<path d="M${A.x + 95} ${A.y + 58} L${B.x + 95} ${B.y - 2}" class="arrow" marker-end="url(#ah2)"/>`;
    return A.x < B.x
      ? `<path d="M${A.x + 190} ${A.y + 29} L${B.x - 2} ${B.y + 29}" class="arrow" marker-end="url(#ah2)"/>`
      : `<path d="M${A.x} ${A.y + 29} L${B.x + 192} ${B.y + 29}" class="arrow" marker-end="url(#ah2)"/>`;
  });
  return `<svg viewBox="0 0 640 260" class="diagram"><defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#18202b"/></marker></defs>${parts.join("")}${arrows.join("")}</svg>`;
}

function k8sSvg(): string {
  const box = (x: number, y: number, w: number, h: number, title: string, lines: string[], color: string) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="#fff" stroke="${color}" stroke-width="2.5"/>
     <text x="${x + 10}" y="${y + 20}" class="pt">${esc(title)}</text>
     ${lines.map((l, i) => `<text x="${x + 10}" y="${y + 38 + i * 15}" class="ps">${esc(l)}</text>`).join("")}`;
  return `<svg viewBox="0 0 640 300" class="diagram">
    <rect x="4" y="4" width="632" height="292" rx="16" class="zone"/>
    <text x="16" y="24" class="zl">Helm release "reelwalk" (one chart, values.yaml for AWS, values-kind.yaml for local)</text>
    ${box(16, 36, 200, 120, "web Deployment", ["2 replicas, rolling update", "maxUnavailable: 0", "readiness: DB + migrations", "liveness: process answers", "Service in front"], "#0079C2")}
    ${box(224, 36, 200, 120, "worker Deployment", ["no Service (pulls from SQS)", "one render per pod", "/dev/shm for Chrome", "long grace period on SIGTERM", "liveness fed by poll loop"], "#E2407F")}
    ${box(432, 36, 196, 120, "migrate Job", ["prisma migrate deploy + seed", "runs before rollout", "name includes a hash", "(pod template is immutable)"], "#8F5BB5")}
    ${box(16, 168, 300, 116, "ConfigMap + Secret", ["settings and credentials via envFrom", "checksum annotation rolls pods on change", "production: Secret from outside the chart", "AWS access through Pod Identity (EKS, one day)"], "#00A3D9")}
    ${box(324, 168, 304, 116, "Every container", ["requests and limits", "non-root, read-only root filesystem", "no privilege escalation, capabilities dropped", "Postgres, MinIO, ElasticMQ live outside the chart"], "#EE8A00")}
  </svg>`;
}

function packagesSvg(): string {
  const node = (x: number, y: number, t: string, s: string, c: string) =>
    `<rect x="${x}" y="${y}" width="180" height="54" rx="10" fill="#fff" stroke="${c}" stroke-width="2.5"/><text x="${x + 90}" y="${y + 23}" text-anchor="middle" class="pt">${t}</text><text x="${x + 90}" y="${y + 41}" text-anchor="middle" class="ps">${s}</text>`;
  const arr = (x1: number, y1: number, x2: number, y2: number) => `<path d="M${x1} ${y1} L${x2} ${y2}" class="arrow" marker-end="url(#ah3)"/>`;
  return `<svg viewBox="0 0 640 220" class="diagram"><defs><marker id="ah3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#18202b"/></marker></defs>
    ${node(100, 10, "apps/web", "Next.js editor", "#0079C2")}
    ${node(360, 10, "apps/worker", "SQS consumer, renders", "#E2407F")}
    ${node(10, 150, "packages/core", "pure rules + state machine", "#00994C")}
    ${node(230, 150, "packages/db", "Prisma schema + client", "#8F5BB5")}
    ${node(450, 150, "packages/render", "Remotion composition", "#EE8A00")}
    ${arr(160, 64, 100, 148)}${arr(190, 64, 300, 148)}${arr(230, 64, 500, 148)}
    ${arr(420, 64, 120, 148)}${arr(440, 64, 330, 148)}${arr(470, 64, 530, 148)}
  </svg>`;
}

// ---------------------------------------------------------------- the PDF

function topicSection(t: Topic): string {
  const g = GROUPS[t.group];
  return `<section class="topic">
    <div class="topic-head" style="--c:${g.color}">
      <h3>${esc(t.name)}</h3><span class="grp">${esc(g.en)}</span><span class="status s-${t.status}">${STATUS[t.status]}</span>
    </div>
    <p class="one">${esc(t.oneLiner.en)}</p>
    <div class="cols">
      <div><h4>How it works</h4><ul>${t.explain.map((l) => `<li>${esc(l.en)}</li>`).join("")}</ul></div>
      <div><h4>Why ReelWalk uses it</h4><ul>${t.why.map((l) => `<li>${esc(l.en)}</li>`).join("")}</ul>
        <h4>What's real</h4><p>${esc(t.statusNote)}</p>
        <h4>In the repo</h4><ul class="repo">${t.inRepo.map((r) => `<li><code>${esc(r.path)}</code> ${esc(r.what)}</li>`).join("")}</ul>
      </div>
    </div>
    <h4>Questions you may get</h4>
    ${t.qa
      .map(
        (qa) => `<div class="qa"><p class="q">Q: ${esc(qa.q.en)}</p><p class="a">${esc(en(qa.a))}</p>${qa.tip ? `<p class="tip">Tip: ${esc(qa.tip)}</p>` : ""}</div>`,
      )
      .join("")}
    <p class="terms"><b>Words:</b> ${t.terms.map((x) => `${esc(x.en)} <span class="jp">(${esc(toPlain(x.ja))})</span>`).join(" · ")}</p>
  </section>`;
}

function decisionSection(dc: (typeof DECISIONS)[number]): string {
  return `<section class="decision">
    <h3>ADR ${dc.adr}: ${esc(dc.title)}</h3>
    <p class="oneline">“${esc(dc.oneLine)}”</p>
    <p><b>Problem.</b> ${esc(dc.problem)}</p>
    <h4>Decision</h4><ul>${dc.decision.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <div class="cols"><div><h4>Why</h4><ul>${dc.why.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>
    <div><h4>Rejected</h4><ul>${dc.rejected.map((r) => `<li><b>${esc(r.option)}:</b> ${esc(r.reason)}</li>`).join("")}</ul></div></div>
    <h4>Costs and consequences</h4><ul>${dc.costs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
  </section>`;
}

function routeSection(r: Route): string {
  return `<section class="route-sec">
    <h3>${esc(r.title.en)}</h3><p class="lede">${esc(r.summary)}</p>
    <div class="route-grid">${systemSvg(r)}
      <ol class="steps">${r.stops
        .map((s) => `<li><b>${esc(byId.get(s.at)?.name.aws ?? s.at)}.</b> ${esc(s.line.en)}${s.more ? ` <span class="more">${esc(en(s.more))}</span>` : ""}</li>`)
        .join("")}</ol>
    </div>
  </section>`;
}

const pitch = (id: string, title: string) => {
  const s = script(id);
  return s ? `<div class="pitch"><h3>${esc(title)}</h3><p>${esc(en(s.lines))}</p></div>` : "";
};

function html(): string {
  const byGroup = GROUP_ORDER.map((g) => ({ g, list: topics.filter((t) => t.group === g) })).filter((x) => x.list.length);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ReelWalk: the stack, explained</title><style>
@font-face { font-family: Archivo; src: url("${fontUrl}") format("woff2"); font-stretch: 62% 125%; font-weight: 100 900; }
@page { size: A4; margin: 14mm 13mm 16mm; }
* { box-sizing: border-box; }
body { font-family: Archivo, "Segoe UI", Arial, sans-serif; color: #18202b; font-size: 10.2pt; line-height: 1.45; margin: 0; }
h1, h2, h3 { font-stretch: 82%; line-height: 1.15; margin: 0 0 6px; }
h1 { font-size: 34pt; font-weight: 800; }
h2 { font-size: 20pt; font-weight: 760; margin-top: 4px; padding-bottom: 6px; border-bottom: 3px solid #18202b; margin-bottom: 12px; }
h3 { font-size: 13.5pt; font-weight: 740; }
h4 { font-size: 9pt; font-weight: 750; color: #5a6472; margin: 8px 0 3px; text-transform: none; }
p { margin: 0 0 6px; }
ul, ol { margin: 0 0 6px; padding-left: 16px; }
li { margin-bottom: 2px; }
code { font-family: Consolas, monospace; font-size: 8.5pt; background: #eef1f4; padding: 0 3px; border-radius: 3px; }
.jp { font-family: "Yu Gothic", "Meiryo", sans-serif; color: #5a6472; }
.page { break-before: page; }
.cover { height: 250mm; display: flex; flex-direction: column; justify-content: space-between; }
.cover .lede { font-size: 13pt; max-width: 140mm; }
.lede { color: #5a6472; }
.toc li { font-size: 11pt; margin-bottom: 4px; }
.box { border: 1.5px solid #d6dce3; border-radius: 10px; padding: 10px 12px; margin: 8px 0; break-inside: avoid; }
.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.diagram { width: 100%; height: auto; display: block; margin: 6px 0 10px; break-inside: avoid; }
.diagram.tall { max-height: 150mm; }
.zone { fill: none; stroke: #c9d1da; stroke-width: 1.5; stroke-dasharray: 5 5; }
.zl { font-size: 10px; font-weight: 700; fill: #5a6472; }
.edge { stroke: #e3e8ed; stroke-width: 6; fill: none; stroke-linecap: round; }
.route { stroke-width: 7; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.nn { font-size: 11.5px; font-weight: 750; font-stretch: 82%; fill: #18202b; }
.ns { font-size: 9.5px; fill: #5a6472; }
.nl { font-size: 8.5px; fill: #8a94a1; font-style: italic; }
.num { font-size: 9px; font-weight: 800; fill: #fff; }
.st { font-size: 13px; font-weight: 800; fill: #18202b; }
.al { font-size: 10.5px; fill: #3c4654; }
.arrow { stroke: #18202b; stroke-width: 1.6; fill: none; }
.pt { font-size: 12px; font-weight: 750; fill: #18202b; }
.ps { font-size: 10px; fill: #5a6472; }
.route-sec { break-before: page; }
.route-grid { display: grid; grid-template-columns: 92mm 1fr; gap: 12px; align-items: start; }
.route-grid .diagram.tall { max-height: 172mm; }
.steps li { margin-bottom: 5px; }
.more { color: #5a6472; }
.topic { break-inside: avoid-page; border-top: 1.5px solid #d6dce3; padding-top: 10px; margin-top: 12px; }
.topic-head { display: flex; align-items: baseline; gap: 10px; border-left: 6px solid var(--c); padding-left: 8px; }
.grp { font-size: 9pt; color: #5a6472; }
.status { margin-left: auto; font-size: 8.5pt; font-weight: 700; border: 1.5px solid currentColor; border-radius: 99px; padding: 1px 8px; }
.s-built { color: #0d7a43; } .s-local { color: #0b6aa6; } .s-designed { color: #8a6a1e; }
.one { font-size: 11pt; font-weight: 600; margin: 6px 0; }
.qa { margin: 4px 0 6px; padding-left: 8px; border-left: 3px solid #e3e8ed; break-inside: avoid; }
.q { font-weight: 700; margin-bottom: 2px; }
.a { margin-bottom: 2px; }
.tip { color: #8a5a00; font-size: 9pt; }
.terms { font-size: 9pt; color: #3c4654; }
.repo { font-size: 9pt; }
.decision { break-inside: avoid-page; border-top: 1.5px solid #d6dce3; padding-top: 10px; margin-top: 12px; }
.oneline { font-size: 11pt; font-style: italic; background: #f2f4f6; border-radius: 8px; padding: 8px 10px; }
.pitch { break-inside: avoid; margin-bottom: 10px; }
.pitch p { font-size: 10.5pt; }
table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 6px 0 10px; }
th, td { text-align: left; border-bottom: 1px solid #d6dce3; padding: 4px 6px; vertical-align: top; }
th { font-size: 9pt; color: #5a6472; }
</style></head><body>

<div class="cover">
  <div>
    <p class="lede">ReelWalk · interview preparation</p>
    <h1>The stack, explained</h1>
    <p class="lede">Every part of ReelWalk in plain English: what it does, how the pieces talk, why each was chosen, what it costs, and what is real today versus only designed. Learn it in English first, then say it in Japanese.</p>
  </div>
  <div class="box"><b>How to use this guide.</b>
    <ol><li>Read the big picture and the four request flows until you can draw the system map from memory.</li>
    <li>Learn each decision's one-line answer, then its "why" and "rejected" lists: interviewers dig for trade-offs.</li>
    <li>Use the XML briefing with a voice agent and let it grill you section by section.</li>
    <li>When your English answers are solid, practise the Japanese versions on the study site.</li></ol>
  </div>
  <p class="lede">Generated ${new Date().toISOString().slice(0, 10)} from the ReelWalk repository and its architecture decision records.</p>
</div>

<div class="page">
  <h2>Contents</h2>
  <ol class="toc">
    <li>Your pitch: 30 seconds, 90 seconds, 3 minutes</li>
    <li>The big picture: system map and code layout</li>
    <li>Four request flows, step by step</li>
    <li>Reliability: job states, duplicate deliveries, crashes</li>
    <li>Platform and delivery: Kubernetes, Helm, CI/CD and GitOps</li>
    <li>Architecture decisions and their trade-offs</li>
    <li>Every component (${topics.length} topics)</li>
    <li>What's real, what's designed</li>
    <li>General interview questions</li>
  </ol>
</div>

<div class="page">
  <h2>1. Your pitch</h2>
  ${pitch("reelwalk-30", "30 seconds")}
  ${pitch("reelwalk-90", "90 seconds")}
  ${pitch("reelwalk-3min", "3 minutes, with one hard problem")}
  ${pitch("honest-scope", "When they ask about AWS")}
  ${pitch("why-stack", "Why this stack fits the job")}
</div>

<div class="page">
  <h2>2. The big picture</h2>
  <p>A phone-first editor for Instagram Reels of property listings. The web app (Next.js) never renders video: it saves an export as a job in Postgres and puts the job's ID on a queue. Separate workers take jobs from the queue, render the MP4 with Remotion and store it in S3. Uploads go straight from the phone to S3.</p>
  <div class="cols">
    ${systemSvg()}
    <div>
      <h4>Read the map in one breath</h4>
      <p>Phone → entry point → Next.js. Next.js reads and writes Postgres and sends jobs to SQS. Workers pull from SQS, read media from S3, render, write the MP4 back to S3 and the status to Postgres. Messages that fail three times go to the dead-letter queue. In production CloudFront delivers the finished videos.</p>
      <h4>Local stand-ins (same code, different endpoints)</h4>
      <table><tr><th>In production (AWS)</th><th>Runs locally as</th></tr>
      ${NODES.filter((n) => n.name.local !== n.name.aws).map((n) => `<tr><td>${esc(n.name.aws)}</td><td>${esc(n.name.local)}</td></tr>`).join("")}
      </table>
      <h4>The bottom row is delivery</h4>
      <p>GitHub Actions tests and scans every change; on main it pushes images to GHCR and records the tag in Git; Argo CD syncs the cluster to Git.</p>
    </div>
  </div>
  <h3>Code layout: one repo, shared packages</h3>
  ${packagesSvg()}
  <p>Web and worker share types and rules through packages, not through HTTP. <code>packages/core</code> holds pure, unit-tested logic: timeline edits, Instagram rules, the job state machine, retry and delivery decisions. Turborepo runs typecheck, test and build in dependency order, generating the Prisma client first.</p>
</div>

<div class="page"><h2>3. Four request flows</h2><p class="lede">Each diagram numbers the stops in order. Being able to walk an interviewer through these is the single most useful thing to practise.</p></div>
${ROUTES.map(routeSection).join("")}

<div class="page">
  <h2>4. Reliability</h2>
  <h3>Render job states</h3>
  ${stateSvg()}
  <p>The legal transitions are a pure function (<code>packages/core/src/job-status.ts</code>). Every change is a single conditional update: the <code>where</code> clause includes the expected status and generation, so if another writer got there first, zero rows change.</p>
  <h3>What a worker does with each delivery</h3>
  <table><tr><th>Job row when the message arrives</th><th>Action</th></tr>
    <tr><td>missing, SUCCEEDED, FAILED, or a different generation</td><td>delete the message (duplicate or stale)</td></tr>
    <tr><td>QUEUED</td><td>claim and render</td></tr>
    <tr><td>RUNNING, heartbeat fresh</td><td>leave it; another worker has it</td></tr>
    <tr><td>RUNNING, heartbeat older than 60 s</td><td>claim and render; the previous worker died</td></tr>
  </table>
  <p>Timing: visibility timeout 120 s, heartbeat every 20 s, stale after 60 s, 3 attempts, backoff 15 s then 30 s.</p>
  <div class="box"><b>Idempotency in four facts.</b>
  <ol><li>The output key is <code>renders/&lt;jobId&gt;.mp4</code>, so a second render overwrites the same file.</li>
  <li><code>RenderOutput.jobId</code> is unique and written with an upsert: one output per job.</li>
  <li>Finished jobs and old generations are discarded without rendering.</li>
  <li>A manual retry bumps the generation, so late messages from the old run are ignored.</li></ol>
  <b>Transactional outbox.</b> The job row and its queue message are written in one transaction (the <code>OutboxMessage</code> table). The web app sends the message right after the commit, and a relay loop in every worker sends whatever is left, so a saved job always gets its message (ADR 0010).<br>
  <b>Honest gap:</b> there is no per-claim fencing token yet.</div>
</div>

<div class="page">
  <h2>5. Platform and delivery</h2>
  <h3>What the Helm chart creates</h3>
  ${k8sSvg()}
  <h3>From a commit to a running pod</h3>
  ${pipelineSvg()}
  <p>CI never touches the cluster. It records the new image tag in Git; Argo CD notices the commit and rolls it out, so a merge to main is a deploy and a revert is a rollback. That GitOps loop runs on the local kind cluster. On main, CI also pushes the same images to ECR through a GitHub OIDC role (no stored keys), and production pulls from there.</p>
</div>

<div class="page">
  <h2>5b. Production on AWS, and the cost decision</h2>
  <p class="lede">Learn this page cold. It is the most likely follow-up question and the best story in the project: you built it the expensive way, measured it, and rebuilt it the cheap way, with the records to prove both.</p>
  <h3>What runs today (ADR 0015), about $10-15 a month</h3>
  <table>
    <tr><th>Piece</th><th>Runs on</th><th>Notes</th></tr>
    <tr><td>Web app</td><td>AWS App Runner, 0.5 vCPU / 1 GB, from the ECR image</td><td>HTTPS, custom domain and certificate are part of the service; no load balancer or ingress. Idle cost about $5.</td></tr>
    <tr><td>Render workers</td><td>ECS Fargate tasks started on demand</td><td>When an export is queued the web app calls ecs:RunTask; the task drains the queue and exits after four idle minutes. A few cents per render, nothing in between.</td></tr>
    <tr><td>Queue</td><td>SQS + dead-letter queue</td><td>Unchanged: lease, heartbeat, retries, outbox.</td></tr>
    <tr><td>Media</td><td>S3 + CloudFront</td><td>Presigned uploads from the phone; CloudFront serves finished videos.</td></tr>
    <tr><td>Images</td><td>ECR, pushed by GitHub Actions via OIDC</td><td>Tag = commit SHA, immutable, scanned on push.</td></tr>
    <tr><td>Config and secrets</td><td>SSM Parameter Store; IAM task and instance roles</td><td>No access keys anywhere in the runtime.</td></tr>
    <tr><td>Database</td><td>Free Postgres tier outside AWS (Supabase)</td><td>The one non-AWS piece; chosen because RDS alone is $15 a month.</td></tr>
    <tr><td>Everything</td><td>Terraform, state in S3</td><td>Existing bucket and CloudFront were imported, not recreated.</td></tr>
  </table>
  <h3>What ran for one day (ADR 0014), about $250 a month</h3>
  <p>EKS 1.34 with one t3.xlarge node, RDS Postgres 16, ingress-nginx behind a network load balancer, cert-manager with Let's Encrypt, Pod Identity for AWS access. It worked: a real render was verified end to end at reelwalking.com. The bill was $73 control plane + $120 node + $17 load balancer + $15 database, nearly all of it idle. It was destroyed the same evening.</p>
  <h3>How to tell it</h3>
  <ul>
    <li>"I did run it on EKS. It proved the Helm chart, IAM, TLS and DNS on a real cluster. Then I looked at the bill and the workload and moved to App Runner plus on-demand Fargate, same images, same queue, about twenty times cheaper."</li>
    <li>Why not Remotion Lambda? Near-zero idle cost and the real long-term answer, but it replaces the worker and needs the WebGL transitions tested under Lambda. Deliberately a separate project.</li>
    <li>What is the trade-off? A cold start of one to two minutes for the first render after a quiet spell, and a small race where a worker exits as a message arrives (the next export picks it up).</li>
    <li>Kubernetes is not gone: the chart and Argo CD run on kind, and the EKS Terraform is in git history, 20 minutes from a rebuild.</li>
  </ul>
</div>

<div class="page"><h2>6. Architecture decisions</h2><p class="lede">Each decision record answers: what was the problem, what did you choose, why, what did you reject, and what does it cost. Learn the one-liner first.</p>
${DECISIONS.map(decisionSection).join("")}</div>

<div class="page"><h2>7. Every component</h2>
${byGroup.map(({ g, list }) => `<h3 style="margin-top:14px">${esc(GROUPS[g].en)}</h3>${list.map(topicSection).join("")}`).join("")}
</div>

<div class="page">
  <h2>8. What's real, what's designed</h2>
  <p class="lede">Never claim the designed column as done. Say "designed and verified locally" instead.</p>
  <table><tr><th>Component</th><th>Status</th><th>Detail</th></tr>
  ${topics.map((t) => `<tr><td><b>${esc(t.name)}</b></td><td class="s-${t.status}">${STATUS[t.status]}</td><td>${esc(t.statusNote)}</td></tr>`).join("")}
  </table>
</div>

<div class="page">
  <h2>9. General interview questions</h2>
  ${generalQA.map((qa) => `<div class="qa"><p class="q">Q: ${esc(qa.q.en)}</p><p class="a">${esc(en(qa.a))}</p>${qa.tip ? `<p class="tip">Tip: ${esc(qa.tip)}</p>` : ""}</div>`).join("")}
  <h3 style="margin-top:12px">About Craftsman Software</h3>
  <ul>${company.facts.map((f) => `<li>${esc(f.line.en)}</li>`).join("")}</ul>
  <h3>Questions to ask them</h3>
  <ul>${company.askThem.map((l) => `<li>${esc(l.en)}</li>`).join("")}</ul>
</div>
</body></html>`;
}

// ---------------------------------------------------------------- the XML

const x = (tag: string, body: string, attrs = "") => `<${tag}${attrs}>${body}</${tag}>`;
const t = (s: string) => esc(s);

function xml(): string {
  const persona = `You are a senior full-stack engineer interviewing a candidate for a full-stack role at Craftsman Software (Tokyo). The real interview will be in Japanese; THIS practice is in English, so the candidate can master the reasoning before translating it. The candidate built ReelWalk, described in <project>. Your job is to grill them, kindly but thoroughly, until they can explain every part, every decision and every trade-off clearly and confidently in English.`;
  const rules = [
    "Speak English. Ask ONE question at a time and wait for the answer.",
    "Start each session by asking which section to practise (pitch, big picture, flows, reliability, platform, decisions, a component, or a mixed mock interview). Default to a mixed mock interview.",
    "After each answer, ask at least one follow-up that digs into WHY, a trade-off, a failure case, or an alternative that was rejected. Use the follow-ups in the knowledge where they fit.",
    "Judge answers only against the facts in this briefing. If the candidate says something that contradicts it, say so gently and give the correct fact.",
    "Treat overclaiming as a serious mistake. Statuses: 'built' runs (locally and, where the note says so, in production on AWS); 'local' uses a stand-in locally and the real AWS service in production; 'designed' was never deployed. The candidate must not describe EKS as current production: it ran for one day and was retired for cost (ADR 0014, 0015). Praise honest scoping and correct numbers.",
    "Do not invent features, numbers or history that are not in this briefing. If asked something the briefing doesn't cover, say it's outside what you know about the project.",
    "After the candidate answers, give brief feedback in this order: one thing that was clear, one thing to add or fix, and a better phrasing in one or two sentences (use the oneLine or model answer when it helps).",
    "If the candidate is stuck for a while or asks for help, give a hint first (a keyword or the first step), then the model answer if they're still stuck.",
    "Keep your turns short (under 60 words) except when giving a model answer.",
    "Encourage clear, slow, structured speech: conclusion first, then two or three reasons, then a trade-off. Point out filler and rambling kindly.",
    "Every 5 questions, or when asked, summarise: strengths, the 3 weakest areas, and what to practise next.",
    "Raise difficulty as answers get stronger: move from 'what does X do' to 'why X and not Y', then to failure scenarios ('the worker dies mid-render: walk me through what happens').",
  ];
  const comp = (tp: Topic) =>
    x(
      "component",
      [
        x("oneLine", t(tp.oneLiner.en)),
        x("howItWorks", tp.explain.map((l) => x("point", t(l.en))).join("")),
        x("why", tp.why.map((l) => x("point", t(l.en))).join("")),
        x("status", t(tp.statusNote), ` value="${tp.status}"`),
        x("inRepo", tp.inRepo.map((r) => x("file", t(r.what), ` path="${t(r.path)}"`)).join("")),
        x(
          "questions",
          tp.qa
            .map((qa) => x("question", x("ask", t(qa.q.en)) + x("modelAnswer", t(en(qa.a))) + (qa.tip ? x("whatTheyCheck", t(qa.tip)) : "")))
            .join(""),
        ),
        x("terms", tp.terms.map((tm) => x("term", t(tm.en), ` ja="${t(toPlain(tm.ja))}"`)).join("")),
      ].join(""),
      ` id="${tp.id}" name="${t(tp.name)}" group="${GROUPS[tp.group].en}"`,
    );
  const body = [
    x("persona", t(persona)),
    x("rules", rules.map((r) => x("rule", t(r))).join("")),
    x(
      "candidate",
      t(
        "JLPT N2 Japanese speaker preparing for a Japanese-language interview on 2026-10-08. Built ReelWalk as a portfolio project with help from AI coding tools, and made and recorded the design decisions. Wants to be able to explain the reasoning, not just recite.",
      ),
    ),
    x(
      "company",
      x("facts", company.facts.map((f) => x("fact", t(f.line.en), ` source="${t(f.source)}"`)).join("")) +
        x("goodQuestionsForThem", company.askThem.map((l) => x("question", t(l.en))).join("")),
    ),
    x(
      "project",
      [
        x(
          "summary",
          t(
            "ReelWalk is a phone-first editor for Instagram Reels of property listings: 360 photos, walkthrough transitions, a floor-plan overlay, music with beat snapping, and exports rendered by separate workers. The web app (Next.js App Router, Server Components, Server Actions) saves an export as a job in PostgreSQL (via Prisma) and sends only the job id to SQS; workers long-poll SQS, render the MP4 with Remotion in headless Chrome, store it in S3 and update the job. It runs locally with Docker Compose and on a local kind Kubernetes cluster via a Helm chart; CI on GitHub Actions lints, typechecks, unit-tests, scans with Trivy, builds images, runs Playwright end-to-end tests with a real render, pushes images to GHCR on main and records the tag in Git for Argo CD to sync. Production is on AWS at reelwalking.com: the web app on App Runner, render workers as Fargate tasks the web app starts on demand, S3 + CloudFront, SQS, ECR (pushed via GitHub OIDC), SSM Parameter Store, all managed by Terraform, with Postgres on a free tier outside AWS; about $10-15 a month. Before that, production ran on EKS with RDS for exactly one day (ADR 0014): it worked, cost about $250 a month mostly idle, and was replaced the same day (ADR 0015). Locally MinIO stands in for S3 and ElasticMQ for SQS, using the same AWS SDK code. Users sign up with email and password (ADR 0012); reels have public share links and a restaurant/cafe builder with stock footage (ADR 0013); one-tap Instagram posting through the Graph API is wired behind a Meta app in development mode.",
          ),
        ),
        x(
          "pitches",
          ["reelwalk-30", "reelwalk-90", "reelwalk-3min", "honest-scope", "why-stack"]
            .map((id) => script(id))
            .filter((s) => s !== undefined)
            .map((s) => x("pitch", t(en(s.lines)), ` id="${s.id}" seconds="${s.seconds}"`))
            .join(""),
        ),
        x(
          "flows",
          ROUTES.map((r) =>
            x(
              "flow",
              x("summary", t(r.summary)) +
                r.stops
                  .map((s, i) => x("step", t(s.line.en + (s.more ? " " + en(s.more) : "")), ` n="${i + 1}" at="${t(byId.get(s.at)?.name.aws ?? s.at)}"`))
                  .join(""),
              ` id="${r.id}" title="${t(r.title.en)}"`,
            ),
          ).join(""),
        ),
        x(
          "reliability",
          [
            "Job states: QUEUED -> RUNNING (worker claims) -> SUCCEEDED (output uploaded). RUNNING -> QUEUED (attempt failed, retry with backoff). RUNNING -> FAILED (attempts exhausted). QUEUED -> FAILED (dead-lettered). FAILED -> QUEUED (manual retry, generation + 1).",
            "Every status change is one conditional update whose where-clause includes the expected status and generation, so concurrent writers can't both win.",
            "Delivery decision: job missing, finished, or different generation -> delete message; QUEUED -> claim; RUNNING with fresh heartbeat -> leave it; RUNNING with heartbeat older than 60 s -> claim (previous worker died).",
            "Timing: visibility timeout 120 s, heartbeat every 20 s, stale after 60 s, 3 attempts, backoff 15 s then 30 s; after 3 receives SQS moves the message to the DLQ, whose consumer marks still-active jobs FAILED.",
            "Idempotency: output key renders/<jobId>.mp4 (a re-render overwrites), RenderOutput.jobId unique with upsert, finished jobs and old generations discarded, manual retry bumps generation.",
            "Transactional outbox (ADR 0010): the job row and its queue message are written in one Postgres transaction (OutboxMessage table). The web app sends right after the commit; a relay loop in every worker (every 5 s, SELECT ... FOR UPDATE SKIP LOCKED, backoff on failure) sends what is left. The relay can send twice, which the idempotent worker absorbs.",
            "Known gaps: no per-claim fencing token; worker autoscaling is CPU-based and off by default (KEDA on queue depth planned).",
          ]
            .map((s) => x("fact", t(s)))
            .join(""),
        ),
        x(
          "decisions",
          DECISIONS.map((dc) =>
            x(
              "decision",
              x("problem", t(dc.problem)) +
                x("choice", dc.decision.map((s) => x("point", t(s))).join("")) +
                x("why", dc.why.map((s) => x("point", t(s))).join("")) +
                x("rejected", dc.rejected.map((r) => x("alternative", t(r.reason), ` option="${t(r.option)}"`)).join("")) +
                x("costs", dc.costs.map((s) => x("point", t(s))).join("")) +
                x("oneLineAnswer", t(dc.oneLine)),
              ` adr="${dc.adr}" title="${t(dc.title)}"`,
            ),
          ).join(""),
        ),
        x("components", topics.map(comp).join("")),
      ].join(""),
    ),
    x(
      "generalQuestions",
      generalQA.map((qa) => x("question", x("ask", t(qa.q.en)) + x("modelAnswer", t(en(qa.a))) + (qa.tip ? x("whatTheyCheck", t(qa.tip)) : ""))).join(""),
    ),
    x(
      "followUps",
      [
        "Why that and not the simplest alternative?",
        "What breaks first if traffic grows ten times?",
        "Walk me through what happens if that component crashes halfway.",
        "How would you know it's broken in production?",
        "What would you change if you started again?",
        "What did you verify yourself, and what is only designed?",
        "Explain it to a non-engineer in two sentences.",
      ]
        .map((s) => x("ask", t(s)))
        .join(""),
    ),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!-- Briefing for a voice interview agent. Paste the whole file as the agent's system prompt / knowledge. Generated from the ReelWalk repo. -->\n<interviewPractice version="1">\n${body}\n</interviewPractice>\n`;
}

// ---------------------------------------------------------------- output

async function main() {
  mkdirSync(outDir, { recursive: true });
  const page = html();
  writeFileSync(`${outDir}reelwalk-study-guide.html`, page);
  const agent = xml();
  writeFileSync(`${outDir}reelwalk-interview-agent.xml`, agent);

  const require = createRequire(new URL("../../../e2e/package.json", import.meta.url));
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch();
  const tab = await browser.newPage();
  await tab.goto(pathToFileURL(`${outDir}reelwalk-study-guide.html`).href, { waitUntil: "networkidle" });
  await tab.pdf({
    path: `${outDir}reelwalk-study-guide.pdf`,
    format: "A4",
    printBackground: true,
    displayHeaderFooter: true,
    headerTemplate: "<span></span>",
    footerTemplate:
      '<div style="font-size:8px;color:#8a94a1;width:100%;padding:0 13mm;display:flex;justify-content:space-between;font-family:Arial"><span>ReelWalk: the stack, explained</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margin: { top: "14mm", bottom: "16mm", left: "13mm", right: "13mm" },
  });
  await browser.close();
  // The HTML is only the print source.
  rmSync(`${outDir}reelwalk-study-guide.html`);
  console.log(`wrote ${outDir}reelwalk-study-guide.pdf and reelwalk-interview-agent.xml (${Math.round(agent.length / 1024)} KB)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
