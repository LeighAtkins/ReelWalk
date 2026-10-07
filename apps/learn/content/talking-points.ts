import type { Line } from "../lib/types";

/**
 * Short, memorable things to say about ReelWalk in the interview. One idea
 * per line, plain N2-level Japanese; furigana only above N2. Keep these true:
 * they follow the ADRs and what is actually deployed (2026-10-07).
 */

export interface PointGroup {
  id: string;
  title: Line;
  /** A picture to remember the group by. */
  hook: string;
  points: Line[];
}

export const TALKING_POINTS: PointGroup[] = [
  {
    id: "app",
    title: { ja: "どんなアプリ？", en: "What it is" },
    hook: "Phone in, Reel out.",
    points: [
      {
        ja: "ReelWalkは、物件{ぶっけん}の写真から、スマホでリール動画を作るアプリです。",
        en: "ReelWalk makes Instagram Reels from property photos, on a phone.",
      },
      {
        ja: "特徴は、動画と一緒に動く、間取{まど}り図{ず}のマーカーです。",
        en: "Its special feature is a floor-plan marker that moves with the video.",
      },
      {
        ja: "レストランも、メニューと自分の動画からリールを作れます。",
        en: "Restaurants can make Reels too, from their menu and their own clips.",
      },
      {
        ja: "できた動画は、共有{きょうゆう}リンクで、どこでも見られます。",
        en: "A finished video can be shared with a link that works anywhere.",
      },
      {
        ja: "今は、reelwalking.comで本当に動いています。",
        en: "It's live today at reelwalking.com.",
      },
    ],
  },
  {
    id: "how",
    title: { ja: "どう動く？", en: "How it works" },
    hook: "Web is the waiter, the queue is the order ticket, the worker is the kitchen.",
    points: [
      {
        ja: "Webはウェイター、キューは注文票{ちゅうもんひょう}、ワーカーはキッチンです。",
        en: "The web app is the waiter, the queue is the order ticket, the worker is the kitchen.",
      },
      {
        ja: "Webアプリは、動画を作りません。注文を受けるだけです。",
        en: "The web app never makes videos. It only takes the order.",
      },
      {
        ja: "正しい情報はデータベースだけ。キューにはIDしか入れません。",
        en: "The database is the only source of truth. The queue only carries an ID.",
      },
      {
        ja: "動画は、スマホからS3へ直接アップロードします。",
        en: "Videos upload straight from the phone to S3.",
      },
      {
        ja: "編集中は軽い720pのコピーを再生して、書き出しは元の動画を使います。",
        en: "While editing, the phone plays a light 720p copy; the export uses the original.",
      },
      {
        ja: "プレビューと書き出しは同じ部品なので、見たままの動画になります。",
        en: "Preview and export use the same component, so what you see is what you get.",
      },
    ],
  },
  {
    id: "break",
    title: { ja: "壊れたら？", en: "When things break" },
    hook: "Twice is fine. Once is the result.",
    points: [
      {
        ja: "メッセージは二回届くかもしれない、と考えて作りました。",
        en: "I designed it assuming a message can arrive twice.",
      },
      {
        ja: "二回動いても、結果は一つです。これが冪等性{べきとうせい}です。",
        en: "If it runs twice, there's still one result. That's idempotency.",
      },
      {
        ja: "ワーカーが止まっても、二分ぐらいで別のワーカーが引{ひ}き継{つ}ぎます。",
        en: "If a worker dies, another one takes over within about two minutes.",
      },
      {
        ja: "三回失敗したら、ジョブは失敗になって、ユーザーがやり直せます。",
        en: "After three failures the job is marked failed, and the user can retry.",
      },
      {
        ja: "ジョブとメッセージは、同じトランザクションで保存します。",
        en: "The job and its message are saved in the same transaction (an outbox).",
      },
      {
        ja: "テストで90本作って、途中でワーカーを止めても、全部成功しました。",
        en: "In a load test, I made 90 videos and killed a worker midway. All 90 succeeded.",
      },
    ],
  },
  {
    id: "aws",
    title: { ja: "AWSとお金", en: "AWS and money" },
    hook: "Built it big, measured it, rebuilt it small.",
    points: [
      {
        ja: "最初はEKSで一日動かして、それから請求額{せいきゅうがく}を見ました。",
        en: "First I ran it on EKS for a day, then I looked at the bill.",
      },
      {
        ja: "ほとんど使わないのに、月250ドル。それは合いませんでした。",
        en: "$250 a month for something mostly idle. That didn't fit.",
      },
      {
        ja: "今はApp Runnerと、必要な時だけ動くFargateで、月10ドルから15ドルくらいです。",
        en: "Now it's App Runner plus Fargate only when needed: about $10 to $15 a month.",
      },
      {
        ja: "書き出しがない時は、サーバーは一台も動いていません。",
        en: "When nobody is exporting, no render server is running at all.",
      },
      {
        ja: "その代わり、最初の書き出しは、始まるまで一、二分かかります。",
        en: "The trade-off: the first export after a quiet spell takes a minute or two to start.",
      },
      {
        ja: "Kubernetesは、今もローカルのkindで、Argo CDと一緒に動いています。",
        en: "Kubernetes isn't gone: it still runs locally on kind, with Argo CD.",
      },
    ],
  },
  {
    id: "ship",
    title: { ja: "安全に出す", en: "Shipping safely" },
    hook: "Test, scan, then ship. No keys anywhere.",
    points: [
      {
        ja: "変更は全部、テストとスキャンをしてから出します。",
        en: "Every change is tested and scanned before it ships.",
      },
      {
        ja: "AWSのリソースは、全部Terraformで管理しています。",
        en: "All the AWS resources are managed in Terraform.",
      },
      {
        ja: "本番にアクセスキーはありません。ロールだけです。",
        en: "There are no access keys in production, only roles.",
      },
      {
        ja: "見つかった脆弱性{ぜいじゃくせい}は、直すか、理由を書いて受け入れます。",
        en: "Each vulnerability found is either fixed, or accepted with a written reason.",
      },
      {
        ja: "ルールはVitestで、画面の流れはPlaywrightで、本物の書き出しまで確かめます。",
        en: "Rules are tested with Vitest, and user flows with Playwright, right up to a real export.",
      },
    ],
  },
  {
    id: "me",
    title: { ja: "正直に、前向きに", en: "Honest and forward-looking" },
    hook: "Say what's done, say what's next.",
    points: [
      {
        ja: "できたことと、まだのことを、はっきり分けて話します。",
        en: "I keep what's done and what's not done clearly separate.",
      },
      {
        ja: "インスタへの直接投稿は作りましたが、まだMetaの開発モードです。",
        en: "Direct posting to Instagram is built, but it's still in Meta's development mode.",
      },
      {
        ja: "AIツールも使いましたが、設計の判断は全部、文書に残しています。",
        en: "I used AI tools too, but every design decision is written down.",
      },
      {
        ja: "一番の学びは、測ってから選ぶことです。",
        en: "My biggest lesson: measure first, then choose.",
      },
      {
        ja: "次は、最初の書き出しを、もっと速くしたいです。",
        en: "Next, I want to make that first export start faster.",
      },
    ],
  },
];
