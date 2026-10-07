import type { Line } from "../lib/types";

/**
 * The 5-page cheat sheet: the questions most likely to come up, with answers
 * short enough to remember, plus the numbers and flows worth knowing cold.
 * Plain N2-level Japanese, furigana only above N2. Keep true to the ADRs.
 */

export interface QuickAnswer {
  q: Line;
  a: Line;
}

export const TOP_QUESTIONS: QuickAnswer[] = [
  {
    q: { en: "Why is the render worker separate?", ja: "なぜワーカーを分けたんですか。" },
    a: {
      en: "Rendering is heavy and slow, so it must never block the web app. They scale and fail separately.",
      ja: "動画作りは重くて時間がかかるので、Webと分けました。別々に増やせて、片方が落ちても大丈夫です。",
    },
  },
  {
    q: { en: "Why SQS?", ja: "なぜSQSですか。" },
    a: {
      en: "Retries, a lease and a dead-letter queue come built in. The cost is duplicate messages, so the worker is idempotent.",
      ja: "リトライとデッドレターキューが最初からあるからです。その代わり重複{ちょうふく}があるので、二回動いても大丈夫に作りました。",
    },
  },
  {
    q: { en: "What if a worker crashes mid-render?", ja: "途中でワーカーが落ちたら、どうなりますか。" },
    a: {
      en: "Its heartbeat stops, the message comes back after two minutes, and another worker takes over. After three tries the job fails and the user can retry.",
      ja: "ハートビートが止まって、二分後にメッセージが戻り、別のワーカーが続けます。三回だめなら失敗にして、ユーザーがやり直せます。",
    },
  },
  {
    q: { en: "How do you avoid two results for one job?", ja: "結果が二つにならないように、どうしていますか。" },
    a: {
      en: "Status changes are conditional updates, the file is named after the job, and there's one output row per job.",
      ja: "状態の更新に条件を付けて、ファイル名をジョブIDにしています。だから、結果は一つです。",
    },
  },
  {
    q: { en: "Why PostgreSQL and Prisma?", ja: "なぜPostgreSQLとPrismaですか。" },
    a: {
      en: "The data is relational, and Prisma gives the web app and the worker one typed schema.",
      ja: "データ同士に関係があるからです。Prismaで、Webとワーカーが同じ型を使えます。",
    },
  },
  {
    q: { en: "Why Server Components and Server Actions?", ja: "なぜServer ComponentsとServer Actionsですか。" },
    a: {
      en: "Pages read the database directly, and every change is a typed function checked with zod. No separate API to maintain.",
      ja: "画面からそのままデータを読めて、更新は型のある関数です。別のAPIを作らなくていいからです。",
    },
  },
  {
    q: { en: "Why did you stop using EKS?", ja: "なぜEKSをやめたんですか。" },
    a: {
      en: "It worked, but it cost about $250 a month for an app that's mostly idle. App Runner plus on-demand Fargate costs $10 to $15.",
      ja: "ちゃんと動きましたが、ほとんど使わないのに月250ドルでした。今は月10ドルから15ドルくらいです。",
    },
  },
  {
    q: { en: "How do you deploy?", ja: "どうやってデプロイしていますか。" },
    a: {
      en: "CI tests and scans every change, then pushes images tagged with the commit to ECR. Production runs those images.",
      ja: "CIでテストとスキャンをして、コミットIDのタグでECRにイメージを送ります。本番はそのイメージを使います。",
    },
  },
  {
    q: { en: "How do you handle vulnerabilities?", ja: "脆弱性{ぜいじゃくせい}には、どう対応していますか。" },
    a: {
      en: "Trivy scans dependencies, config and images in CI. Each finding is fixed, or accepted with a written reason.",
      ja: "CIでTrivyがスキャンします。直すか、受け入れる理由を書いて残します。",
    },
  },
  {
    q: { en: "Did you use AI to build it?", ja: "AIを使って作りましたか。" },
    a: {
      en: "Yes, as a tool. Every design decision is written down, and I can explain each one.",
      ja: "はい、道具として使いました。設計の判断は全部書いてあって、一つずつ説明できます。",
    },
  },
  {
    q: { en: "What would you improve next?", ja: "次に何を良くしたいですか。" },
    a: {
      en: "A faster first export, scaling workers by queue length, and Instagram posting out of development mode.",
      ja: "最初の書き出しを速くすること、キューの長さでワーカーを増やすこと、インスタ投稿を本番にすることです。",
    },
  },
];

export const NUMBERS: { what: string; value: string }[] = [
  { what: "Visibility timeout / heartbeat / stale after", value: "120 s / every 20 s / 60 s" },
  { what: "Attempts before the dead-letter queue", value: "3 (backoff 15 s, then 30 s)" },
  { what: "EKS for one day → today", value: "~$250/month → ~$10–15/month" },
  { what: "Idle worker exits after / cold start", value: "4 minutes / 1–2 minutes" },
  { what: "Load test", value: "90 of 90 videos correct, with a worker killed" },
  { what: "Editing preview / export source", value: "720p copy / the original" },
  { what: "Instagram Reel length / caption", value: "3 s – 3 min / 2,200 characters" },
  { what: "Upload limit / login session", value: "2 GB / 30 days" },
];

export const FLOWS: { name: string; chain: string[] }[] = [
  {
    name: "Upload",
    chain: ["Phone picks a file", "Server Action checks it, returns a presigned URL", "Phone uploads straight to S3", "Server confirms it", "Row in Postgres"],
  },
  {
    name: "Export",
    chain: [
      "Tap Export",
      "Job + outbox row, one transaction",
      "Job ID to SQS",
      "Fargate task starts if none is running",
      "Worker claims the job",
      "Remotion renders the MP4",
      "MP4 to S3, job SUCCEEDED",
      "Message deleted; phone shows it",
    ],
  },
  {
    name: "Crash",
    chain: ["Worker dies", "Heartbeat stops", "Message reappears after 120 s", "New worker sees a stale heartbeat, takes over", "3 failures → dead-letter queue → FAILED", "User retries (generation + 1)"],
  },
  {
    name: "Deploy",
    chain: ["Pull request", "Lint, typecheck, unit tests", "Trivy scans", "Build and scan images", "Playwright end-to-end", "Merge: images to ECR tagged with the commit"],
  },
];

/** Phrases that buy time or steer the conversation. */
export const LIFELINES: Line[] = [
  { ja: "少し考えてもよろしいでしょうか。", en: "May I think for a moment?" },
  { ja: "もう一度おっしゃっていただけますか。", en: "Could you say that once more?" },
  { ja: "結論から言うと、", en: "To give the conclusion first," },
  { ja: "つまり、〜ということですね。", en: "So you mean …, right?" },
  { ja: "正直に言うと、そこはまだ試していません。", en: "To be honest, I haven't tried that yet." },
  { ja: "例えば、ReelWalkでは、", en: "For example, in ReelWalk," },
];
