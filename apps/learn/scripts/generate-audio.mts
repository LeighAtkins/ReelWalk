/* global console, process, fetch, URL, URLSearchParams, Buffer */
/**
 * Renders every spoken Japanese line to public/audio/<key>.wav with a local
 * VOICEVOX engine (https://voicevox.hiroshiba.jp/). Run the engine first:
 *   docker run --rm --gpus all -p 50021:50021 voicevox/voicevox_engine:nvidia-latest
 * then: node scripts/generate-audio.mts [--list] [--voice ryusei|no7]
 * Files that already exist are skipped, so re-running only renders new lines.
 * scripts/encode-audio.sh turns the WAVs into MP3s.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appTopics } from "../content/topics-app.ts";
import { asyncTopics } from "../content/topics-async.ts";
import { platformTopics } from "../content/topics-platform.ts";
import { company, generalQA, phraseSets, scripts } from "../content/interview.ts";
import { ROUTES } from "../content/map.ts";
import { OPENER, VOICE_TEST } from "../content/misc.ts";
import { OPENING, REPEAT_PHRASE } from "../content/game.ts";
import { parseRuby } from "../lib/ruby.ts";
import { audioKey } from "../lib/audio-key.ts";

const ENGINE = process.env.VOICEVOX_URL ?? "http://127.0.0.1:50021";
const args = process.argv.slice(2);
const VOICES: Record<string, number> = { ryusei: 13, no7: 30 };
const voice = args[args.indexOf("--voice") + 1] in VOICES ? args[args.indexOf("--voice") + 1] : "ryusei";
const speaker = VOICES[voice];
const wavDir = fileURLToPath(new URL(`../.audio-wav/${voice}/`, import.meta.url));
const mp3Dir = fileURLToPath(new URL(`../public/audio/${voice}/`, import.meta.url));

const topics = [...appTopics, ...asyncTopics, ...platformTopics];

/** Every string the app can pass to speak(): all `ja` fields, plus each topic's spoken name. */
function collect(): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if ((k === "ja" || k === "say") && typeof x === "string") out.add(x);
        else walk(x);
      }
    }
  };
  walk([topics, company, generalQA, phraseSets, scripts, ROUTES, OPENER, VOICE_TEST, OPENING, REPEAT_PHRASE]);
  return [...out];
}

/**
 * Latin names read the way Japanese engineers say them. Topic names come
 * from each topic's `say`; the rest are names that appear inside sentences.
 */
const LATIN: Record<string, string> = {
  ...Object.fromEntries(topics.filter((t) => /[A-Za-z]/.test(t.name)).map((t) => [t.name, t.say])),
  "Server Components": "サーバーコンポーネンツ",
  "Server Component": "サーバーコンポーネント",
  "Client Components": "クライアントコンポーネンツ",
  "Client Component": "クライアントコンポーネント",
  "Server Actions": "サーバーアクションズ",
  "Server Action": "サーバーアクション",
  "App Router": "アップルーター",
  "GitHub Actions": "ギットハブアクションズ",
  GitHub: "ギットハブ",
  "Next.js": "ネクストジェイエス",
  "Node.js": "ノードジェイエス",
  TypeScript: "タイプスクリプト",
  JavaScript: "ジャバスクリプト",
  React: "リアクト",
  ReelWalk: "リールウォーク",
  Remotion: "リモーション",
  PostgreSQL: "ポストグレスキューエル",
  Postgres: "ポストグレス",
  ElasticMQ: "イラスティックエムキュー",
  MinIO: "ミニオ",
  Docker: "ドッカー",
  Kubernetes: "クバネティス",
  Helm: "ヘルム",
  kind: "カインド",
  "Argo CD": "アルゴシーディー",
  Terraform: "テラフォーム",
  Trivy: "トリビー",
  Vitest: "ヴィテスト",
  Playwright: "プレイライト",
  Turborepo: "ターボレポ",
  Prisma: "プリズマ",
  CloudFront: "クラウドフロント",
  CloudWatch: "クラウドウォッチ",
  Bedrock: "ベッドロック",
  AppThrust: "アップスラスト",
  Instagram: "インスタグラム",
  Reels: "リール",
  zod: "ゾッド",
  pnpm: "ピーエヌピーエム",
  npm: "エヌピーエム",
  Chrome: "クローム",
  ffmpeg: "エフエフエムペグ",
  readiness: "レディネス",
  liveness: "ライブネス",
  Lint: "リント",
  lint: "リント",
  "Web": "ウェブ",
  "web": "ウェブ",
  "worker": "ワーカー",
  "Pod": "ポッド",
  "Pod1": "ポッドワン",
  "Job": "ジョブ",
  "Git": "ギット",
  "Redis": "レディス",
  "Secret": "シークレット",
  "Secrets": "シークレッツ",
  "root": "ルート",
  "values-kind.yaml": "バリューズカインドヤムル",
  "values.yaml": "バリューズヤムル",
  "yaml": "ヤムル",
  "values": "バリューズ",
  "generate": "ジェネレート",
  "state": "ステート",
  "packages": "パッケージズ",
  "core": "コア",
  "Identity": "アイデンティティ",
  "helm": "ヘルム",
  "GitOps": "ギットオプス",
  "apply": "アプライ",
  "ready": "レディ",
  "migrate": "マイグレート",
  "test": "テスト",
  "Compose": "コンポーズ",
  "undo": "アンドゥ",
  "redo": "リドゥ",
  "unknown": "アンノウン",
  "Route Handler": "ルートハンドラー",
  "Route": "ルート",
  "Handler": "ハンドラー",
  "standalone": "スタンドアロン",
  "health": "ヘルス",
  "props": "プロップス",
  "updateMany": "アップデートメニー",
  "remotion": "リモーション",
  "prisma": "プリズマ",
  "deploy": "デプロイ",
  "HeadObject": "ヘッドオブジェクト",
  "turbo.json": "ターボジェイソン",
  "turbo": "ターボ",
  "jobId": "ジョブアイディー",
  "workspaceId": "ワークスペースアイディー",
  "Claude": "クロード",
  "node": "ノード",
  "Node": "ノード",
  "Dockerfile": "ドッカーファイル",
  "requests": "リクエスツ",
  "limits": "リミッツ",
  "ConfigMap": "コンフィグマップ",
  "NodePort": "ノードポート",
  "localhost": "ローカルホスト",
  "plan": "プラン",
  "FAILED": "フェイルド",
  "QUEUED": "キュード",
  "RUNNING": "ランニング",
  "SUCCEEDED": "サクシーデッド",
  "ID": "アイディー",
  "db": "ディービー",
  "MP4": "エムピーフォー",
  "JSON": "ジェイソン",
  "GB": "ギガバイト",
  "KB": "キロバイト",
  "upgrade": "アップグレード",
  "Linux": "リナックス",
  "Windows": "ウィンドウズ",
  "Desktop": "デスクトップ",
  "Chromium": "クロミウム",
  "nginx": "エンジンエックス",
  "Vite": "ヴィート",
  "Jest": "ジェスト",
  "Kustomize": "カスタマイズ",
  "Dependabot": "ディペンダボット",
  "Gaussian Splatting": "ガウシアンスプラッティング",
  "Platform Engineering Kaigi": "プラットフォームエンジニアリングカイギ",
  "Application": "アプリケーション",
  "Deployment": "デプロイメント",
  "ServiceAccount": "サービスアカウント",
  "Service": "サービス",
  "Amazon": "アマゾン",
  "Elastic": "イラスティック",
  "Manager": "マネージャー",
  "External": "エクスターナル",
  "Logs": "ログズ",
  "Cookie": "クッキー",
  "upsert": "アップサート",
  "generation": "ジェネレーション",
  "render": "レンダー",
  "build": "ビルド",
  "typecheck": "タイプチェック",
  "apps": "アップス",
  "app": "アップ",
  "dev": "デブ",
  "globalThis": "グローバルディス",
  "asyncpg": "アシンクピージー",
  "Outbox": "アウトボックス",
  "timeline": "タイムライン",
  "saveReel": "セーブリール",
  "fetch": "フェッチ",
  "client": "クライアント",
  "use client": "ユーズクライアント",
  "async": "アシンク",
  "player": "プレイヤー",
  "video": "ビデオ",
  "media": "メディア",
  "Editor": "エディター",
  "useReducer": "ユーズリデューサー",
  "any": "エニー",
  "push": "プッシュ",
  "run": "ラン",
  "main": "メイン",
  "prune": "プルーン",
  "selfHeal": "セルフヒール",
  "revert": "リバート",
  "overrides": "オーバーライズ",
  "esbuild": "イーエスビルド",
  "corepack": "コアパック",
  "tsx": "ティーエスエックス",
  "infra": "インフラ",
  "reelwalk": "リールウォーク",
  "in": "イン",
  "maxUnavailable": "マックスアンアベイラブル",
  "WebCodecs": "ウェブコーデックス",
  "OffthreadVideo": "オフスレッドビデオ",
  "ReelComposition": "リールコンポジション",
  "inputs": "インプッツ",
  "dependsOn": "ディペンズオン",
  "sync-wave": "シンクウェーブ",
  "id-token": "アイディートークン",
  "HIGH": "ハイ",
  "CRITICAL": "クリティカル",
  "UPDATE": "アップデート",
  "WHERE": "ウェア",
  "GET": "ゲット",
  "RENDER_CONCURRENCY": "レンダーコンカレンシー",
  "DATABASE_URL": "データベースユーアールエル",
  "USER": "ユーザー",
  "FIFO": "ファイフォ",
  "STAR": "スター",
  "KEDA": "ケダ",
  "IAM": "アイアム",
  "REST": "レスト",
  "router.refresh": "ルーターリフレッシュ",
  "vi.fn": "ブイアイファンクション",
  "schema.prisma": "スキーマプリズマ",
  "decideDelivery": "ディサイドデリバリー",
  "up.sh": "アップシェル",
  "Actions": "アクションズ",
  "Action": "アクション",
  "E2E": "イーツーイー",
  "Pixel": "ピクセル",
  "nit": "ニット",
  "Code": "コード",
  "Claude Code": "クロードコード",
  "data-status": "データステータス",
  "data-testid": "データテストアイディー",
  "Kaigi": "カイギ",
  "api": "エーピーアイ",
  "SIGTERM": "シグターム",
  "IaC": "アイエーシー",
  "fps": "エフピーエス",
  "where": "ウェア",
  "DynamoDB": "ダイナモディービー",
  "e2e": "イーツーイー",
  "CEATEC": "シーテック",
};
const latinKeys = Object.keys(LATIN).sort((a, b) => b.length - a.length);
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const latinPattern = new RegExp(`(?<![A-Za-z])(${latinKeys.map(escape).join("|")})(?![A-Za-z])`, "g");

/**
 * Kanji go to the engine as kanji: its dictionary splits words and places
 * pitch accent far better than it does from kana. A line is sent with the
 * furigana substituted only when the engine would otherwise read it
 * differently (see chooseSpeech).
 */
/** Readings go in as katakana so the engine can't take は, へ or を for a particle. */
const katakana = (s: string) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));

/** `swap` holds the annotated words (`base{reading}`) to send as their reading. */
export function speechText(raw: string, swap: Set<string> | "all" = new Set()): string {
  return parseRuby(raw)
    .map((t) =>
      t.kind === "text" ? t.text : t.latin || swap === "all" || swap.has(`${t.base}{${t.reading}}`) ? katakana(t.reading) : t.base,
    )
    .join("")
    .replace(/[【】]/g, "")
    .replace(latinPattern, (m) => LATIN[m]);
}

/** Hiragana or engine kana, reduced to how it sounds, for comparing readings. */
function sound(kana: string): string {
  return kana
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/['/_、？\s]/g, "")
    .replace(/ヂ/g, "ジ")
    .replace(/ヅ/g, "ズ")
    .replace(/([エケセテネヘメレゲゼデベペ])イ/g, "$1エ")
    .replace(/([オコソトノホモヨロゴゾドボポョ])ウ/g, "$1オ");
}

async function engineKana(text: string): Promise<string> {
  const q = new URLSearchParams({ text, speaker: String(speaker) });
  const r = await fetch(`${ENGINE}/audio_query?${q}`, { method: "POST" });
  if (!r.ok) throw new Error(`audio_query ${r.status}`);
  return (await r.json()).kana as string;
}

/**
 * The text to send for each line. The engine reads the kanji version; any
 * annotated word whose furigana isn't in what it would say is swapped for
 * its reading (in katakana), leaving the rest of the line as kanji.
 */
async function chooseSpeech(texts: string[]): Promise<Map<string, string>> {
  const chosen = new Map<string, string>();
  const report: string[] = [];
  for (const t of texts) {
    const words = parseRuby(t).filter((x) => x.kind === "ruby" && !x.latin) as { base: string; reading: string }[];
    if (words.length === 0) {
      chosen.set(t, speechText(t));
      continue;
    }
    const heard = sound(await engineKana(speechText(t)));
    const swap = new Set(words.filter((w) => !heard.includes(sound(w.reading))).map((w) => `${w.base}{${w.reading}}`));
    chosen.set(t, speechText(t, swap));
    if (swap.size) report.push(`${[...swap].join(" ")}  in  ${speechText(t)}`);
  }
  console.log(`${texts.length} lines, ${report.length} with words swapped for their furigana`);
  if (args.includes("--fixes")) console.log(report.join("\n"));
  return chosen;
}

async function synth(text: string): Promise<Buffer> {
  const q = new URLSearchParams({ text, speaker: String(speaker) });
  const query = await fetch(`${ENGINE}/audio_query?${q}`, { method: "POST" });
  if (!query.ok) throw new Error(`audio_query ${query.status}: ${await query.text()}`);
  const body = await query.json();
  body.speedScale = 1.0;
  body.prePhonemeLength = 0.05;
  body.postPhonemeLength = 0.15;
  body.outputSamplingRate = 24000;
  const wav = await fetch(`${ENGINE}/synthesis?speaker=${speaker}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!wav.ok) throw new Error(`synthesis ${wav.status}: ${await wav.text()}`);
  return Buffer.from(await wav.arrayBuffer());
}

async function main() {
  const texts = collect();
  if (args.includes("--fixes")) return void (await chooseSpeech(texts));
  if (args.includes("--list")) {
    const latin = new Map<string, number>();
    for (const t of texts) for (const m of speechText(t).match(/[A-Za-z][A-Za-z0-9.+-]*/g) ?? []) latin.set(m, (latin.get(m) ?? 0) + 1);
    console.log(`${texts.length} lines, ${texts.reduce((n, t) => n + speechText(t).length, 0)} characters`);
    console.log("Latin words left for the engine:", [...latin].sort((a, b) => b[1] - a[1]).map(([w, n]) => `${w}×${n}`).join(" "));
    return;
  }
  const chosen = await chooseSpeech(texts);
  mkdirSync(wavDir, { recursive: true });
  mkdirSync(mp3Dir, { recursive: true });
  const todo = texts.filter((t) => !existsSync(`${mp3Dir}${audioKey(t)}.mp3`) && !existsSync(`${wavDir}${audioKey(t)}.wav`));
  console.log(`${texts.length} lines, ${todo.length} to render with ${voice} (speaker ${speaker})`);
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    for (let t = todo.pop(); t !== undefined; t = todo.pop()) {
      writeFileSync(`${wavDir}${audioKey(t)}.wav`, await synth(chosen.get(t) ?? speechText(t, "all")));
      if (++done % 100 === 0) console.log(`${done} rendered, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  console.log(`done: ${done} rendered`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
