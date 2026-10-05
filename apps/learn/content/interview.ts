/**
 * Interview practice for the Craftsman Software interview (held in Japanese).
 *
 * Company facts were checked against the company's own pages and its job post
 * on HERP (fetched 2026-10-05). 【】 marks a personal fact to fill in before
 * practising. Scripts are honest about scope: AWS is designed, not deployed;
 * everything runs locally (Docker Compose, kind) and in CI.
 */
import type { Line, PhraseSet, QA, Script } from "../lib/types";

const SITE = "https://craftsman-software.com/";
const COMPANY = "https://craftsman-software.com/company";
const RECRUIT = "https://craftsman-software.com/recruit";
const APPTHRUST_POST = "https://craftsman-software.com/posts/88";
const PE_KAIGI_POST = "https://craftsman-software.com/posts/93";
const JOB = "https://herp.careers/v1/c16e/8UrRreC16bXp";

export const company: { facts: { line: Line; source: string }[]; askThem: Line[] } = {
  facts: [
    {
      line: {
        ja: "コーポレートメッセージは「つくることに、もっと集中できる世界へ。」です。開発からインフラ、運用までを一貫{いっかん}して支える会社です。",
        en: "Their message is \"Toward a world where we can focus more on creating.\" They support software end to end, from development through infrastructure to operations.",
      },
      source: SITE,
    },
    {
      line: {
        ja: "企業理念は「ソフトウェアを、誠実{せいじつ}につくる。」です。設計・実装・運用のすべてに責任を持つ、という考え方です。",
        en: "Their philosophy is \"Build software with integrity\": take responsibility for design, implementation and operation alike.",
      },
      source: COMPANY,
    },
    {
      line: {
        ja: "大切にしていることは「ユーザーに誠実{せいじつ}に向き合う」「技術で課題を解く」「チームで価値を最大化する」「自動化で未来をつくる」の四つです。技術選定はチームの裁量{さいりょう}で、役職に関係なく意見を出せる文化です。",
        en: "Their four values: face users with integrity, solve problems with technology, maximise value as a team, build the future with automation. Technology choices are left to each team, and anyone can speak up regardless of seniority.",
      },
      source: RECRUIT,
    },
    {
      line: {
        ja: "自社プロダクトの[AppThrust]{アップスラスト}は、お客様自身のAWSに、[Kubernetes]{クバネティス}ベースのアプリ基盤を作るサービスです。GitHubにpushするとビルドされ、新しい版に通信を1%から少しずつ流してリリースできます。",
        en: "Their own product, AppThrust, builds a Kubernetes-based application platform in the customer's own AWS account. A push to GitHub triggers a build, and a new revision can be released gradually, starting with 1% of traffic.",
      },
      source: APPTHRUST_POST,
    },
    {
      line: {
        ja: "2026年9月に、Platform Engineering Kaigi 2026と東京ゲームショウ2026でAppThrustを出展しました。次はCEATEC 2026（10月13日〜16日）に出展予定です。",
        en: "In September 2026 they exhibited AppThrust at Platform Engineering Kaigi 2026 and Tokyo Game Show 2026, and they are exhibiting next at CEATEC 2026 (13-16 October).",
      },
      source: PE_KAIGI_POST,
    },
    {
      line: {
        ja: "募集中のチームは、[Next.js]{ネクストジェイエス}のServer ComponentsとServer Actionsで作った出荷管理系ツールを保守開発しています。2024年4月に最小限の機能でリリースし、PO1名と開発者3名で、アジャイルに進めています。",
        en: "The team you would join maintains and extends a shipping-management tool built with Next.js Server Components and Server Actions. It launched with a minimal feature set in April 2024; the team is one product owner and three developers, working in an agile way.",
      },
      source: JOB,
    },
    {
      line: {
        ja: "社員の9割弱がエンジニアで、CNCFのトップコントリビューターも在籍しています。取締役の野澤{のざわ}さんは『サバイバルTypeScript』の執筆者の一人です。",
        en: "Nearly 90% of staff are engineers, including a top CNCF contributor. Director Hidehito Nozawa is one of the authors of \"Survival TypeScript\".",
      },
      source: JOB,
    },
    {
      line: {
        ja: "勉強会は業務時間内に行い、業務に関係するOSSへの貢献{こうけん}もできます。会社としてAI活用を推進しており、残業は月平均約5時間です。US進出やグローバル展開も視野に入れています。",
        en: "Study sessions happen during working hours, and contributing to work-related OSS is allowed. The company actively promotes using AI, overtime averages about 5 hours a month, and they are considering expanding to the US and hiring globally.",
      },
      source: JOB,
    },
  ],
  askThem: [
    {
      ja: "出荷管理ツールのチームで、今いちばん力を入れている課題は何でしょうか。",
      en: "What is the shipping-management team focusing on most right now?",
    },
    {
      ja: "CI/CDと脆弱性{ぜいじゃくせい}対応は、今どのような流れで進めていらっしゃいますか。",
      en: "How do you currently run CI/CD and handle vulnerabilities?",
    },
    {
      ja: "Server ActionsとPrismaを運用してみて、苦労された点があれば伺{うかが}いたいです。",
      en: "I'd like to hear about anything that was hard once you ran Server Actions and Prisma in production.",
    },
    {
      ja: "AppThrustで得られた知見は、受託のプロジェクトにも生かされていますか。",
      en: "Does what you learn building AppThrust feed back into client projects?",
    },
    {
      ja: "入社して最初の3か月で、どのような状態になっていることを期待されますか。",
      en: "What would you expect me to be able to do after my first three months?",
    },
    {
      ja: "コードレビューは、どのような観点や進め方で行っていますか。",
      en: "How does code review work on the team, and what do reviewers look for?",
    },
    {
      ja: "AI活用を推進されていると拝見{はいけん}しました。チームではどのように使っていますか。",
      en: "I read that the company promotes using AI. How does the team use it day to day?",
    },
    {
      ja: "日本語が母語ではないメンバーと、一緒に働かれたことはありますか。",
      en: "Have you worked with team members whose first language is not Japanese?",
    },
  ],
};

export const scripts: Script[] = [
  {
    id: "self-intro",
    title: { ja: "自己紹介", en: "Self-introduction" },
    seconds: 60,
    intro:
      "The opener, about one minute. Fill in every 【】 with your own facts before practising, and keep each one to a short phrase. End by handing over to ReelWalk, since that is what they will ask about next.",
    lines: [
      { ja: "本日はお時間をいただき、ありがとうございます。", en: "Thank you for your time today." },
      { ja: "【氏名】と申{もう}します。よろしくお願いいたします。", en: "My name is 【name】. It's a pleasure to meet you." },
      {
        ja: "【出身国】出身で、エンジニアとして【年数】年ほど働いてきました。",
        en: "I'm from 【country】 and have worked as an engineer for about 【years】 years.",
      },
      {
        ja: "前職の【前職の会社名】では、【担当した業務】を担当いたしました。",
        en: "At my previous company, 【company】, I was responsible for 【role / work】.",
      },
      {
        ja: "主に【使っていた技術】を使って、【一言で成果】に携{たずさ}わりました。",
        en: "Mainly using 【technologies】, I worked on 【achievement in a few words】.",
      },
      {
        ja: "最近は、個人で[ReelWalk]{リールウォーク}というアプリを開発しています。",
        en: "Recently I've been building an app of my own called ReelWalk.",
      },
      {
        ja: "物件の紹介動画を、スマホでリール用に編集するアプリです。",
        en: "It's an app for editing property videos into Reels on a phone.",
      },
      {
        ja: "御社{おんしゃ}の技術スタックに合わせて、設計からCI/CDまで一人で作りました。",
        en: "I matched it to your tech stack and built everything myself, from the design to CI/CD.",
      },
      {
        ja: "日本語はまだ勉強中ですが、分からないことは確認しながら進めています。",
        en: "I'm still studying Japanese, but I make a habit of checking anything I'm unsure about.",
      },
      { ja: "本日はどうぞよろしくお願いいたします。", en: "Thank you, and I look forward to our conversation." },
    ],
  },
  {
    id: "reelwalk-30",
    title: { ja: "ReelWalkを30秒で", en: "ReelWalk in 30 seconds" },
    seconds: 30,
    intro:
      "The elevator version: what it is, what is special, how it is built. Use it when they say 「簡単に教えてください」. Stop after the last line and let them ask.",
    lines: [
      {
        ja: "[ReelWalk]{リールウォーク}は、不動産のリール動画を作るスマホ向けの編集アプリです。",
        en: "ReelWalk is a phone-first editor for making real-estate Reels.",
      },
      {
        ja: "写真や動画、360度写真を並べて、文字や音楽を入れて書き出せます。",
        en: "You arrange photos, videos and 360 photos, add text and music, and export.",
      },
      {
        ja: "特徴は、間取{まど}り図{ず}の上で、現在地のマーカーが動くことです。",
        en: "What makes it different is a \"you are here\" marker that moves across the floor plan.",
      },
      {
        ja: "書き出しは、キューを通して、別のワーカーで行います。",
        en: "Exports go through a queue and are rendered on a separate worker.",
      },
      {
        ja: "Next.jsとPrisma、Kubernetesなど、御社{おんしゃ}に近い技術で作りました。",
        en: "I built it with technology close to yours: Next.js, Prisma, Kubernetes and so on.",
      },
    ],
  },
  {
    id: "reelwalk-90",
    title: { ja: "ReelWalkを90秒で", en: "ReelWalk in 90 seconds" },
    seconds: 90,
    intro:
      "Four parts in a fixed order: product, architecture, reliability, delivery. Pause briefly between parts. The last line states the AWS scope up front, so nobody is surprised later.",
    lines: [
      {
        ja: "[ReelWalk]{リールウォーク}は、物件紹介のリール動画をスマホで作るアプリです。",
        en: "ReelWalk is an app for making property-listing Reels on a phone.",
      },
      {
        ja: "不動産会社が、外注せずに自分で動画を作れることを目指しました。",
        en: "The goal is that agents can make the video themselves instead of outsourcing it.",
      },
      {
        ja: "カットや並べ替え、文字、音楽、360度写真の演出ができます。",
        en: "You can cut, reorder, add text and music, and animate 360 photos.",
      },
      {
        ja: "構成は、[Next.js]{ネクストジェイエス}のWebアプリと、動画を作るワーカーの二つです。",
        en: "It has two parts: a Next.js web app and a worker that renders the video.",
      },
      {
        ja: "画面はServer Components、更新はすべてServer Actionsです。",
        en: "Pages are Server Components, and every change goes through a Server Action.",
      },
      {
        ja: "データはPostgreSQLとPrisma、動画などのファイルはS3に置きます。",
        en: "Data lives in PostgreSQL through Prisma; videos and other files go to S3.",
      },
      {
        ja: "素材は、ブラウザから署名付きURLで、S3に直接アップロードします。",
        en: "The browser uploads media straight to S3 with a presigned URL.",
      },
      {
        ja: "書き出しを押すと、ジョブを保存して、IDだけをSQSに送ります。",
        en: "When you press Export, the job is saved and only its ID is sent to SQS.",
      },
      {
        ja: "SQSは、同じメッセージが二回届くことがあります。",
        en: "SQS can deliver the same message twice.",
      },
      {
        ja: "そのため、ワーカーは冪等{べきとう}に作りました。",
        en: "So I made the worker idempotent.",
      },
      {
        ja: "状態は条件付きで更新するので、二重に完了することはありません。",
        en: "Status changes are conditional updates, so a job can never complete twice.",
      },
      {
        ja: "デプロイは[Helm]{ヘルム}チャートで、ローカルの[kind]{カインド}クラスタに行っています。",
        en: "It's deployed with a Helm chart to a local kind cluster.",
      },
      {
        ja: "GitHub Actionsで、テストと脆弱性{ぜいじゃくせい}スキャン、E2Eテストを回しています。",
        en: "GitHub Actions runs the tests, vulnerability scans and end-to-end tests.",
      },
      {
        ja: "AWSは設計までで、本番環境にはまだデプロイしていません。",
        en: "AWS is designed for, but nothing has been deployed to production yet.",
      },
    ],
  },
  {
    id: "reelwalk-3min",
    title: { ja: "ReelWalkを3分で（苦労した点）", en: "ReelWalk in 3 minutes, with the hard problem" },
    seconds: 180,
    intro:
      "For \"tell me more\" or \"what was hardest?\". Product in one breath, architecture in four lines, then the real hard problem: a job lost on a worker crash (commit 1039f6c), the move to SQS (ADR 0001), and idempotent completion (ADR 0003). It ends with the gap that is still open, which shows judgement.",
    lines: [
      { ja: "ReelWalkについて、少し詳しくご説明します。", en: "Let me explain ReelWalk in a bit more detail." },
      {
        ja: "物件の動画は、外注すると高く、自分で編集すると時間がかかります。",
        en: "Property videos are expensive to outsource and slow to edit yourself.",
      },
      {
        ja: "そこで、スマホだけでリール動画を作れるアプリにしました。",
        en: "So I made an app that does the whole Reel on a phone.",
      },
      {
        ja: "特徴は、間取{まど}り図{ず}のマーカーが、映像に合わせて動くことです。",
        en: "Its signature feature is a floor-plan marker that moves in step with the video.",
      },
      {
        ja: "構成としては、Next.jsのWebアプリと、動画を作るワーカーを分けています。",
        en: "Architecturally, the Next.js web app and the rendering worker are separate.",
      },
      {
        ja: "書き出しは、CPUもメモリも多く使い、数分かかるからです。",
        en: "Rendering uses a lot of CPU and memory and can take minutes.",
      },
      {
        ja: "Webは軽いままにして、ワーカーだけを増やせるようにしました。",
        en: "That keeps the web app light and lets me scale only the workers.",
      },
      {
        ja: "プレビューと書き出しは、同じReactのコンポーネントで描いています。",
        en: "The preview and the export are drawn by the same React component.",
      },
      {
        ja: "なので、スマホで見た映像と、書き出した動画がずれません。",
        en: "So what you see on the phone matches the exported video.",
      },
      { ja: "ここからは、一番苦労した点をお話しします。", en: "Now let me talk about the hardest part." },
      {
        ja: "それは、書き出しのジョブを、確実に一回だけ完了させることでした。",
        en: "It was making sure each export job completes exactly once.",
      },
      {
        ja: "最初は、Redisのリストでジョブを渡していました。",
        en: "At first I passed jobs through a Redis list.",
      },
      {
        ja: "ところが、ワーカーが処理中に落ちると、ジョブが消えてしまいました。",
        en: "But when a worker crashed mid-render, the job simply disappeared.",
      },
      { ja: "そこで、SQSに切り替えました。", en: "So I switched to SQS." },
      {
        ja: "SQSは、受け取ったメッセージを一定時間、ほかから見えなくします。",
        en: "SQS hides a received message from other consumers for a set time.",
      },
      {
        ja: "時間内に削除されなければ、また別のワーカーに届きます。",
        en: "If it isn't deleted in time, it's delivered to another worker.",
      },
      {
        ja: "ただし、同じメッセージが二回届く可能性があります。",
        en: "The catch is that the same message may arrive twice.",
      },
      {
        ja: "なので、二回届いても結果は一つになるように、冪等性{べきとうせい}を持たせました。",
        en: "So I made the worker idempotent: two deliveries still give one result.",
      },
      {
        ja: "一つ目は、状態の更新を条件付きにしたことです。",
        en: "First, status updates are conditional.",
      },
      {
        ja: "「実行中のときだけ完了にする」ので、遅れた側は何も変えられません。",
        en: "\"Mark done only if still running\" means the late one changes nothing.",
      },
      {
        ja: "二つ目は、出力ファイルの名前をジョブIDで固定したことです。",
        en: "Second, the output file is named after the job ID.",
      },
      {
        ja: "二回作っても、同じファイルを上書{うわが}きするだけです。",
        en: "Rendering twice just overwrites the same file.",
      },
      {
        ja: "三つ目は、ハートビートです。20秒ごとに、DBに生存を書きます。",
        en: "Third, a heartbeat: every 20 seconds the worker writes to the database that it's alive.",
      },
      {
        ja: "60秒止まっていたら、別のワーカーが引き継ぎます。",
        en: "If it stops for 60 seconds, another worker takes over.",
      },
      {
        ja: "手動で再試行するときは世代番号を上げて、古いメッセージを捨てます。",
        en: "A manual retry bumps a generation number, so old messages are discarded.",
      },
      {
        ja: "3回失敗したら、デッドレターキューに移して、失敗として記録します。",
        en: "After three failures the message goes to a dead-letter queue and the job is marked failed.",
      },
      {
        ja: "この判断は純粋{じゅんすい}な関数にして、Vitestでケースごとにテストしました。",
        en: "I made that decision logic a pure function and tested each case with Vitest.",
      },
      { ja: "ただ、まだ残っている課題もあります。", en: "There is still one open gap, though." },
      {
        ja: "ジョブの保存とメッセージの送信が、一つのトランザクションではありません。",
        en: "Saving the job and sending the message aren't one transaction.",
      },
      {
        ja: "送信に失敗した場合は、ジョブを失敗にして、再試行できるようにしています。",
        en: "If the send fails, the job is marked failed so the user can retry.",
      },
      {
        ja: "次は、トランザクショナル・アウトボックスで、この隙間{すきま}を埋めたいです。",
        en: "Next I'd like to close that gap with a transactional outbox.",
      },
      {
        ja: "この経験から、失敗する前提で設計することを、強く意識するようになりました。",
        en: "This taught me to design on the assumption that things will fail.",
      },
    ],
  },
  {
    id: "honest-scope",
    title: { ja: "AWSの範囲を正直に伝える", en: "Being honest about AWS scope" },
    seconds: 60,
    intro:
      "Say this before they find it in the repo. Calm and factual, no apology spiral: what is designed, what was verified locally and how, what kind cannot prove, and what you want to learn on the job. ADR 0005 is the written source.",
    lines: [
      { ja: "一点、先にお伝えしておきたいことがあります。", en: "There's one thing I'd like to mention up front." },
      { ja: "AWSへのデプロイは、まだ行っていません。", en: "I haven't deployed to AWS yet." },
      {
        ja: "アカウントの本人確認が終わらず、間に合わなかったためです。",
        en: "My account's identity verification didn't finish in time.",
      },
      {
        ja: "その代わり、ローカルで同じAPIを使って検証{けんしょう}しました。",
        en: "Instead, I verified everything locally against the same APIs.",
      },
      {
        ja: "S3はMinIO、SQSはElasticMQ、EKSはkindで置き換えています。",
        en: "MinIO stands in for S3, ElasticMQ for SQS, and kind for EKS.",
      },
      {
        ja: "アプリはAWS SDKのままで、変わるのは接続先の設定だけです。",
        en: "The app still uses the AWS SDK; only the endpoint settings change.",
      },
      {
        ja: "環境の違いは、Helmのvaluesファイルにまとめました。",
        en: "The differences between environments are kept in Helm values files.",
      },
      {
        ja: "Terraformも、S3やSQS、RDSなどの下書きまでは書いてあります。",
        en: "I've also drafted Terraform for S3, SQS, RDS and so on.",
      },
      {
        ja: "CIはGitHub Actionsで、すべて通っています。",
        en: "CI runs on GitHub Actions, and everything passes.",
      },
      {
        ja: "ただ、IAMの権限やロードバランサー、TLSは、実際のEKSでないと確かめられません。",
        en: "But IAM permissions, the load balancer and TLS can only be proven on a real EKS cluster.",
      },
      {
        ja: "そこは「未検証{みけんしょう}」として、ADRに明記{めいき}しています。",
        en: "I've stated clearly in an ADR that those are unverified.",
      },
      {
        ja: "動かしていないものを、動いたとは言わないようにしています。",
        en: "I make a point of never claiming something works when I haven't run it.",
      },
      {
        ja: "入社後は、実際のAWS環境で、この差を埋める経験を積みたいです。",
        en: "After joining, I want to gain experience closing that gap on real AWS.",
      },
    ],
  },
  {
    id: "motivation",
    title: { ja: "志望{しぼう}動機", en: "Why this company" },
    seconds: 75,
    intro:
      "Two reasons, each tied to something they wrote themselves (the company message and the job post), then what you would do first. Replace the 【】 with a real experience; one concrete sentence beats three general ones.",
    lines: [
      { ja: "御社{おんしゃ}を志望{しぼう}した理由は、大きく二つあります。", en: "There are two main reasons I applied to your company." },
      {
        ja: "一つ目は、「つくることに、もっと集中できる世界へ」という考え方です。",
        en: "The first is your idea of \"a world where we can focus more on creating.\"",
      },
      {
        ja: "私も【前職での経験】で、手作業の多さに困った経験があります。",
        en: "At 【previous job / experience】, I also struggled with too much manual work.",
      },
      {
        ja: "その経験から、自動化やCI/CDの改善に強い関心を持っています。",
        en: "Since then I've been very interested in automation and improving CI/CD.",
      },
      {
        ja: "二つ目は、アプリとインフラの両方に携{たずさ}われる点です。",
        en: "The second is the chance to work on both the application and the infrastructure.",
      },
      {
        ja: "求人を拝見{はいけん}して、Next.jsのアプリをKubernetesで動かしていると知りました。",
        en: "From the job post, I learned that you run a Next.js app on Kubernetes.",
      },
      {
        ja: "それはまさに、私がReelWalkで一番力を入れて学んだ組み合わせです。",
        en: "That is exactly the combination I put the most effort into learning with ReelWalk.",
      },
      {
        ja: "また、AppThrustのように、自社で開発者向けの基盤を作っている点にも惹{ひ}かれました。",
        en: "I'm also drawn to the fact that you build a platform for developers yourselves, like AppThrust.",
      },
      {
        ja: "【ほかに惹{ひ}かれた点：例えば業務時間内の勉強会】",
        en: "【Another thing that attracts you, e.g. study sessions during working hours】",
      },
      {
        ja: "入社後は、まず出荷管理ツールの開発で貢献{こうけん}したいです。",
        en: "After joining, I'd first like to contribute to the shipping-management tool.",
      },
      {
        ja: "将来的には、CI/CDや脆弱性{ぜいじゃくせい}対応の改善にも関わりたいと考えています。",
        en: "Longer term, I'd also like to help improve CI/CD and vulnerability handling.",
      },
    ],
  },
  {
    id: "why-stack",
    title: { ja: "技術スタックが合う理由", en: "Why my stack matches the job" },
    seconds: 75,
    intro:
      "Walk their stack in the order of the job post and give one concrete thing you did with each. Say plainly which parts you have run (Next.js, Prisma, Helm on kind, CI) and which you have only written (Argo CD). That contrast reads as self-aware, not weak.",
    lines: [
      {
        ja: "求人の技術スタックは、ReelWalkとほぼ同じです。",
        en: "The stack in your job post is almost the same as ReelWalk's.",
      },
      {
        ja: "意図的に合わせて、「なぜ使うのか」を一つずつ理解しながら作りました。",
        en: "I matched it on purpose and built it understanding why each piece is there.",
      },
      {
        ja: "Server Componentsでは、Prismaから直接データを読んでいます。",
        en: "Server Components read data directly through Prisma.",
      },
      {
        ja: "Server Actionsでは、zodで入力を検証{けんしょう}し、ワークスペースも確認します。",
        en: "Server Actions validate input with zod and check the workspace.",
      },
      {
        ja: "[Turborepo]{ターボレポ}では、Prismaのクライアント生成を先に実行させています。",
        en: "Turborepo makes sure the Prisma client is generated before anything else.",
      },
      {
        ja: "テストは、ロジックをVitest、画面の流れをPlaywrightで確認しています。",
        en: "Logic is tested with Vitest, and user flows with Playwright.",
      },
      {
        ja: "CIでは、Trivyで依存関係とイメージをスキャンしています。",
        en: "In CI, Trivy scans the dependencies and the images.",
      },
      {
        ja: "実行用のイメージから、パッケージマネージャーや開発用の依存を外しました。",
        en: "I removed package managers and dev dependencies from the runtime images.",
      },
      {
        ja: "Helmチャートは、非rootで動かし、リソースの上限も設定しています。",
        en: "The Helm chart runs as non-root and sets resource limits.",
      },
      {
        ja: "Argo CDは、マニフェストは用意しましたが、継続的には運用していません。",
        en: "For Argo CD, I've written the manifests but haven't run it continuously.",
      },
      {
        ja: "すぐに手を動かせる部分と、これから学ぶ部分がはっきりしています。",
        en: "So I'm clear about where I can contribute right away and what I still need to learn.",
      },
    ],
  },
  {
    id: "closing",
    title: { ja: "最後に一言", en: "Closing words" },
    seconds: 30,
    intro:
      "For 「最後に何かありますか」. Thank them, name one thing from the conversation that stuck with you (fill 【】 on the day), restate commitment, finish. Under 30 seconds.",
    lines: [
      {
        ja: "本日は貴重なお時間をいただき、ありがとうございました。",
        en: "Thank you very much for your valuable time today.",
      },
      {
        ja: "お話を伺{うかが}って、【印象に残った点】がとても魅力的だと感じました。",
        en: "Hearing about 【what stood out】 made the role even more appealing to me.",
      },
      {
        ja: "日本語はまだ伸ばす余地がありますが、技術と姿勢で貢献{こうけん}したいです。",
        en: "My Japanese still has room to grow, but I want to contribute through my skills and attitude.",
      },
      {
        ja: "分からないことは素直に聞いて、早くチームの力になれるよう努めます。",
        en: "I'll ask openly when I don't understand, and work to become useful to the team quickly.",
      },
      {
        ja: "ぜひ御社{おんしゃ}で働かせていただきたいと思っております。",
        en: "I would very much like to work with you.",
      },
      { ja: "どうぞよろしくお願いいたします。", en: "Thank you." },
    ],
  },
];

export const generalQA: QA[] = [
  {
    q: { ja: "あなたの強みは何ですか。", en: "What are your strengths?" },
    a: [
      { ja: "私の強みは、仕組みを理解してから作ることです。", en: "My strength is understanding how things work before I build." },
      {
        ja: "ReelWalkでは、技術ごとに「なぜ使うか」をADRに残しました。",
        en: "In ReelWalk, I recorded why I use each technology in ADRs.",
      },
      {
        ja: "例えばSQSを選んだ理由と、選ばなかった案も書いています。",
        en: "For example, why I chose SQS and which options I rejected.",
      },
      {
        ja: "そのため、後から聞かれても、判断の理由を説明できます。",
        en: "So I can explain the reasoning behind a decision even later on.",
      },
    ],
    tip: "One strength, one piece of evidence they can check in the repo. Don't list three adjectives.",
  },
  {
    q: { ja: "あなたの弱みは何ですか。", en: "What is your weakness?" },
    a: [
      {
        ja: "一人で深く調べすぎてしまうことがあります。",
        en: "I sometimes dig too deep on my own.",
      },
      {
        ja: "ReelWalkでも、ローカルだけで起きる遅延の調査に、時間をかけすぎました。",
        en: "In ReelWalk, I spent too long investigating a delay that only happened locally.",
      },
      {
        ja: "今は時間を区切って、途中で状況を共有するようにしています。",
        en: "Now I set a time box and share progress partway through.",
      },
      {
        ja: "チームでは、早めに相談するほうが、全体として速いと考えています。",
        en: "In a team, asking early is faster overall.",
      },
    ],
    tip: "A real weakness plus what you now do about it. The 10 s stall is true: Playwright traces, then a 2-worker workaround instead of chasing it forever.",
  },
  {
    q: { ja: "チーム開発の経験について教えてください。", en: "Tell me about your experience developing in a team." },
    a: [
      {
        ja: "前職では、【人数】人のチームで【開発内容】を担当いたしました。",
        en: "At my previous job, I worked on 【what】 in a team of 【number】.",
      },
      {
        ja: "【進め方：例えば、毎朝の朝会と2週間のスプリント】で進めていました。",
        en: "We worked with 【process, e.g. a daily stand-up and two-week sprints】.",
      },
      {
        ja: "私が意識していたのは、作業の状況を早めに見える形にすることです。",
        en: "What I paid attention to was making my progress visible early.",
      },
      { ja: "【具体的なエピソードを一つ】", en: "【One concrete episode】" },
    ],
    tip: "Their team is a PO plus three developers, works from documents and tickets, and checks the day's plan every morning. Mirror that if it is true for you.",
  },
  {
    q: { ja: "コードレビューで気をつけていることはありますか。", en: "What do you pay attention to in code review?" },
    a: [
      { ja: "まず、変更の目的が説明どおりかを確認します。", en: "First, I check the change does what the description says." },
      { ja: "次に、エラー時や同時実行のときの動きを見ます。", en: "Next, I look at behaviour on errors and under concurrency." },
      {
        ja: "指摘するときは、理由と代案をセットで書くようにしています。",
        en: "When I comment, I always give the reason and an alternative.",
      },
      {
        ja: "好みの問題は「nit」と書いて、相手が判断できるようにします。",
        en: "Matters of taste I mark as \"nit\" so the author can decide.",
      },
      {
        ja: "レビューを受ける側としては、PRを小さく分けるようにしています。",
        en: "As an author, I keep pull requests small.",
      },
    ],
    tip: "The job post asks for someone who considers the other person (相手を慮る). Show you review the code, not the person.",
  },
  {
    q: { ja: "技術選定はどのように行いますか。", en: "How do you choose technologies?" },
    a: [
      { ja: "まず、解決したい課題と制約をはっきりさせます。", en: "First I pin down the problem and the constraints." },
      { ja: "次に、候補を二、三個に絞って、トレードオフを比べます。", en: "Then I narrow it to two or three options and compare trade-offs." },
      { ja: "例えばキューは、Redis、PostgreSQL、SQSを比べました。", en: "For the queue, for example, I compared Redis, PostgreSQL and SQS." },
      {
        ja: "SQSは、再配信とデッドレターキューが最初からある点で選びました。",
        en: "I chose SQS because redelivery and a dead-letter queue come built in.",
      },
      { ja: "決めた理由は、ADRとして残しています。", en: "I record the reasons as ADRs." },
    ],
    tip: "At this company technology choices are the team's call, so they want people who can justify one. Mention a rejected option.",
  },
  {
    q: { ja: "失敗した経験と、そこから学んだことを教えてください。", en: "Tell me about a failure and what you learned." },
    a: [
      { ja: "最初の版では、Redisのリストでジョブを渡していました。", en: "In the first version, I passed jobs through a Redis list." },
      {
        ja: "ワーカーが処理中に落ちると、そのジョブが消えてしまいました。",
        en: "When a worker crashed mid-job, the job was lost.",
      },
      {
        ja: "キューが失敗しない、という前提で作っていたのが原因です。",
        en: "The cause was that I'd assumed the queue would never fail.",
      },
      {
        ja: "それ以来、失敗や重複{ちょうふく}が起きる前提で設計しています。",
        en: "Since then I design assuming failures and duplicates will happen.",
      },
      {
        ja: "今は、SQSと冪等{べきとう}な処理で対応しています。",
        en: "Now it's handled with SQS and idempotent processing.",
      },
    ],
    tip: "Own the mistake in one line, spend the rest on the lesson. If you have a work example, use it instead and keep this one for the ReelWalk questions.",
  },
  {
    q: { ja: "最近、どんな技術を学んでいますか。", en: "What technology are you learning lately?" },
    a: [
      { ja: "最近は、Kubernetesを集中して学んでいます。", en: "Lately I've been focusing on Kubernetes." },
      {
        ja: "kindでHelmチャートを動かして、プローブやリソース制限を設定しました。",
        en: "I ran a Helm chart on kind and set up probes and resource limits.",
      },
      {
        ja: "CKADのレベルを目標に、【勉強方法】で学んでいます。",
        en: "I'm aiming for CKAD level, studying with 【method】.",
      },
      {
        ja: "ほかに、Gaussian Splattingで、物件の3D映像も試しました。",
        en: "I've also experimented with Gaussian splatting for 3D property video.",
      },
    ],
    tip: "CKAD-level Kubernetes is a plus in the post. Name something you actually configured (readiness vs liveness is a good follow-up to be ready for).",
  },
  {
    q: { ja: "脆弱性{ぜいじゃくせい}対応は、どのように進めますか。", en: "How do you handle a vulnerability?" },
    a: [
      {
        ja: "まず、どの依存関係が、どこで使われているかを確認します。",
        en: "First I check which dependency is affected and where it's used.",
      },
      {
        ja: "次に、実際に悪用できるかと深刻度{しんこくど}を見て、優先度を決めます。",
        en: "Then I set the priority from severity and whether it's actually exploitable.",
      },
      {
        ja: "修正版があれば更新して、テストで壊れていないことを確かめます。",
        en: "If there's a fix, I update and confirm with tests that nothing broke.",
      },
      {
        ja: "すぐ直せない場合は、理由を書いて一時的に許容{きょよう}します。",
        en: "If it can't be fixed right away, I accept it temporarily with a written reason.",
      },
      {
        ja: "ReelWalkでは、Trivyの除外設定に、必ず理由を書いています。",
        en: "In ReelWalk, every Trivy exception has its reason written down.",
      },
      {
        ja: "依存の更新は、Dependabotで毎週提案されるように設定しました。",
        en: "I've set up Dependabot to propose dependency updates weekly.",
      },
    ],
    tip: "This is a listed duty. Show a process (scope, exploitability, fix, verify, record), not just \"I run npm audit\".",
  },
  {
    q: { ja: "CI/CDで改善したいことはありますか。", en: "Is there anything you'd like to improve in CI/CD?" },
    a: [
      { ja: "一つ目は、フィードバックの速さです。", en: "First, the speed of feedback." },
      {
        ja: "Turborepoのキャッシュで、変更のないパッケージは飛ばせます。",
        en: "Turborepo's cache can skip packages that haven't changed.",
      },
      {
        ja: "二つ目は、セキュリティのチェックを早い段階に入れることです。",
        en: "Second, moving security checks earlier in the pipeline.",
      },
      {
        ja: "三つ目は、Argo CDで、Gitの状態と本番を一致させることです。",
        en: "Third, using Argo CD to keep production in line with what's in Git.",
      },
      {
        ja: "ただ、まずは今の課題を伺{うかが}ってから、優先度を決めたいです。",
        en: "But I'd want to hear your current pain points before setting priorities.",
      },
    ],
    tip: "CI/CD improvement is a listed duty. Offer ideas, then defer to their reality; proposing fixes before you know the pipeline sounds arrogant.",
  },
  {
    q: { ja: "テストの方針を教えてください。", en: "What is your approach to testing?" },
    a: [
      {
        ja: "ロジックは純粋{じゅんすい}な関数に切り出して、Vitestでテストします。",
        en: "I pull logic out into pure functions and test them with Vitest.",
      },
      {
        ja: "例えば、ジョブの状態遷移{じょうたいせんい}や、再試行の判断です。",
        en: "For example, job state transitions and retry decisions.",
      },
      {
        ja: "画面の流れは、Playwrightで本物のブラウザから確認します。",
        en: "User flows are checked in a real browser with Playwright.",
      },
      {
        ja: "E2Eでは、実際に動画を書き出すところまで通しています。",
        en: "The end-to-end tests go as far as actually rendering a video.",
      },
      {
        ja: "E2Eは遅いので、数は単体テストを中心にしています。",
        en: "End-to-end tests are slow, so most of the tests are unit tests.",
      },
    ],
    tip: "Their stack is Vitest plus Playwright, the same split. Mention the test pyramid without using jargon for its own sake.",
  },
  {
    q: { ja: "なぜ日本で働きたいのですか。", en: "Why do you want to work in Japan?" },
    a: [
      {
        ja: "【日本との接点：例えば留学や仕事】がきっかけで、日本に関心を持ちました。",
        en: "I became interested in Japan through 【your connection, e.g. study or work】.",
      },
      {
        ja: "日本のチームの、品質に対する丁寧な姿勢を尊敬しています。",
        en: "I respect how carefully Japanese teams approach quality.",
      },
      {
        ja: "御社{おんしゃ}の「ソフトウェアを、誠実{せいじつ}につくる」にも、それを感じました。",
        en: "I felt the same in your phrase \"build software with integrity.\"",
      },
      { ja: "【日本での生活の状況や予定】", en: "【Your situation or plans for living in Japan】" },
      {
        ja: "長く日本で働いて、エンジニアとして成長したいと考えています。",
        en: "I want to work in Japan for the long term and grow as an engineer.",
      },
    ],
    tip: "They want to know you will stay. Be concrete about visa, location and timeline if asked; keep it positive about Japan, not negative about home.",
  },
  {
    q: { ja: "日本語での業務に、不安はありませんか。", en: "Are you worried about working in Japanese?" },
    a: [
      {
        ja: "技術的な会話は、ゆっくりであれば対応できます。",
        en: "I can handle technical conversations if they're not too fast.",
      },
      { ja: "読み書きは、JLPTのN2レベルです。", en: "My reading and writing are at JLPT N2 level." },
      {
        ja: "分からない言葉は、その場で確認するようにしています。",
        en: "When I don't know a word, I check it on the spot.",
      },
      {
        ja: "大事な決定は、チケットやチャットに文字で残すと確実だと思います。",
        en: "I find important decisions are safest written down in tickets or chat.",
      },
      {
        ja: "毎日【勉強方法】で、仕事で使う日本語を伸ばしています。",
        en: "Every day I improve my work Japanese through 【method】.",
      },
    ],
    tip: "This whole interview is the answer. Be honest about the level, show a strategy; their team works from documents and tickets, which helps you.",
  },
  {
    q: { ja: "入社後にやりたいことは何ですか。", en: "What would you like to do after joining?" },
    a: [
      { ja: "まずは、出荷管理ツールのコードと業務を理解したいです。", en: "First, I want to understand the shipping tool's code and its business." },
      {
        ja: "小さな改修やバグ修正から始めて、早めにリリースを経験したいです。",
        en: "I'd start with small changes and bug fixes and ship something early.",
      },
      {
        ja: "その後は、CI/CDや脆弱性{ぜいじゃくせい}対応の改善に関わりたいです。",
        en: "After that I'd like to work on improving CI/CD and vulnerability handling.",
      },
      {
        ja: "将来は、アプリとインフラの両方を任されるエンジニアを目指します。",
        en: "Eventually I want to be trusted with both the app and the infrastructure.",
      },
    ],
    tip: "Show a ramp: learn, ship small, then improve. Naming their product shows you read the post.",
  },
  {
    q: { ja: "AIツールは、どのように使っていますか。", en: "How do you use AI tools?" },
    a: [
      { ja: "普段から、AIのコーディングエージェントを使っています。", en: "I use AI coding agents every day." },
      { ja: "ReelWalkも、Claude Codeと一緒に作りました。", en: "I built ReelWalk together with Claude Code too." },
      {
        ja: "ただ、設計の判断は自分で行い、理由をADRに残しています。",
        en: "But I make the design decisions myself and record the reasons in ADRs.",
      },
      {
        ja: "生成されたコードは、テストとレビューで必ず確認します。",
        en: "I always check generated code with tests and review.",
      },
      {
        ja: "秘密情報を渡さないなど、使い方のルールも大切にしています。",
        en: "I also follow rules on usage, like never pasting secrets.",
      },
    ],
    tip: "The company promotes AI use, and the public repo shows AI co-authored commits, so be open about it. The point to land: you own the decisions and can explain every part.",
  },
  {
    q: { ja: "チームで意見が分かれたら、どうしますか。", en: "What do you do when the team disagrees?" },
    a: [
      { ja: "まず、相手の意見の背景を聞きます。", en: "First I ask about the reasoning behind the other view." },
      { ja: "多くの場合、前提や優先度が違うだけです。", en: "Usually it's just different assumptions or priorities." },
      {
        ja: "判断の基準をそろえてから、小さく試して比べます。",
        en: "Once we agree on criteria, we compare with a small experiment.",
      },
      {
        ja: "決まったことには、自分の案でなくても全力で取り組みます。",
        en: "Once it's decided, I commit fully even if it wasn't my idea.",
      },
    ],
    tip: "Value: チームで価値を最大化する. They are checking cooperation, not who wins.",
  },
  {
    q: { ja: "転職を考えた理由を教えてください。", en: "Why are you looking for a new job?" },
    a: [
      { ja: "【前職での状況を前向きに一言】", en: "【One positive line about your current or last job】" },
      {
        ja: "その中で、アプリとインフラの両方に関わりたいと思うようになりました。",
        en: "Along the way, I came to want to work on both the app and the infrastructure.",
      },
      {
        ja: "ReelWalkを作って、KubernetesやCI/CDが特に面白いと感じました。",
        en: "Building ReelWalk, I found Kubernetes and CI/CD especially interesting.",
      },
      {
        ja: "その経験を、実際のプロダクトとチームで生かしたいと考えています。",
        en: "I want to apply that on a real product, with a real team.",
      },
    ],
    tip: "Never criticise a previous employer. Frame it as moving toward something they offer.",
  },
  {
    q: { ja: "フロントエンドとバックエンド、どちらが得意ですか。", en: "Are you stronger in frontend or backend?" },
    a: [
      { ja: "経験としては、【得意な方】のほうが長いです。", en: "In terms of experience, I've done more 【frontend / backend】." },
      { ja: "ただ、ReelWalkでは両方を一人で作りました。", en: "But in ReelWalk I built both myself." },
      {
        ja: "例えば自動保存は、画面とサーバーの両方にまたがる話です。",
        en: "Autosave, for example, spans both the screen and the server.",
      },
      {
        ja: "古い版のデータでの保存を断って、別のタブの上書{うわが}きを防いでいます。",
        en: "Saves based on an old revision are rejected, so a second tab can't overwrite the first.",
      },
      { ja: "どちらか一方より、その境目の設計が好きです。", en: "More than either side, I enjoy designing the boundary between them." },
    ],
    tip: "Full-stack roles want someone comfortable at the seam. The revision check (ADR 0006) is a good concrete example.",
  },
  {
    q: { ja: "障害{しょうがい}が起きたとき、どう対応しますか。", en: "How do you respond to a production incident?" },
    a: [
      { ja: "まず影響範囲{えいきょうはんい}を確認して、関係者に共有します。", en: "First I check the impact and tell the people affected." },
      { ja: "次に暫定{ざんてい}対応で、ユーザーへの影響を止めます。", en: "Then I stop the user impact with a quick mitigation." },
      {
        ja: "落ち着いてから、ログで根本原因{こんぽんげんいん}を調べます。",
        en: "Once things are stable, I find the root cause from the logs.",
      },
      {
        ja: "最後に再発防止策を決めて、振{ふ}り返{かえ}りを残します。",
        en: "Finally we agree on prevention and write up a retrospective.",
      },
      { ja: "【実際の障害対応の経験があれば一言】", en: "【One line from a real incident, if you have one】" },
    ],
    tip: "Order matters: communicate, mitigate, then investigate. Don't claim on-call experience you don't have.",
  },
  {
    q: { ja: "出社での勤務は問題ありませんか。", en: "Is working in the office OK for you?" },
    a: [
      { ja: "はい、問題ありません。", en: "Yes, no problem." },
      { ja: "【住んでいる場所と、神田までの通勤時間】", en: "【Where you live and the commute to Kanda】" },
      {
        ja: "席が近いと相談しやすいので、私には合っていると思います。",
        en: "Sitting close makes it easy to ask questions, so I think it suits me.",
      },
    ],
    tip: "The post asks for office work at the Kanda office, and says the team sits close and talks as needed.",
  },
];

export const phraseSets: PhraseSet[] = [
  {
    id: "ask-again",
    title: { ja: "聞き返す・確認する", en: "Asking to repeat or clarify" },
    intro:
      "Asking back is normal and polite in Japanese interviews. A clarified question answered well beats a guessed one. Use the confirm-the-intent forms for technical questions.",
    phrases: [
      {
        ja: "恐{おそ}れ入{い}りますが、もう一度おっしゃっていただけますか。",
        en: "I'm sorry, could you say that once more?",
        when: "You missed the question entirely.",
      },
      {
        ja: "すみません、もう少しゆっくりお話しいただけますか。",
        en: "Sorry, could you speak a little more slowly?",
      },
      {
        ja: "申{もう}し訳{わけ}ありません、最後のところが聞き取れませんでした。",
        en: "I'm sorry, I didn't catch the last part.",
      },
      {
        ja: "確認させてください。〜についてのご質問でしょうか。",
        en: "Let me check: is the question about ~?",
      },
      {
        ja: "〜ということでよろしいでしょうか。",
        en: "Do I understand correctly that ~?",
        when: "Restate the question in your own words.",
      },
      {
        ja: "設計と実装、どちらについてお答えすればよろしいですか。",
        en: "Should I answer about the design or the implementation?",
      },
      {
        ja: "今の「〜」という言葉の意味を、教えていただけますか。",
        en: "Could you tell me what you mean by \"~\"?",
        when: "An unfamiliar word or in-house term.",
      },
      {
        ja: "ご質問の意図を確認してもよろしいでしょうか。",
        en: "May I check what you are looking for with that question?",
      },
    ],
  },
  {
    id: "time-to-think",
    title: { ja: "考える時間をもらう", en: "Buying time to think" },
    intro:
      "Silence feels long in a second language. One of these buys you five to ten seconds without looking lost. Then start with the conclusion.",
    phrases: [
      { ja: "少し考えてもよろしいでしょうか。", en: "May I think for a moment?" },
      { ja: "少々お時間をいただけますか。", en: "Could I have a moment?" },
      {
        ja: "そうですね……。",
        en: "Let me see...",
        when: "A natural filler; better than English \"um\".",
      },
      {
        ja: "考えたことのない観点でした。少し整理させてください。",
        en: "That's an angle I hadn't considered. Let me organise my thoughts.",
      },
      {
        ja: "結論から申{もう}し上{あ}げると、〜です。",
        en: "To give you the conclusion first, ~.",
        when: "Start the answer once you have it.",
      },
      { ja: "ポイントは二つあります。", en: "There are two points." },
      {
        ja: "一つずつお答えしてもよろしいでしょうか。",
        en: "May I answer them one at a time?",
        when: "A question with several parts.",
      },
    ],
  },
  {
    id: "dont-know",
    title: { ja: "分からない・経験がない時", en: "When you don't know or haven't done it" },
    intro:
      "Say no clearly, then bridge to something nearby that you do know. Never bluff: a follow-up question will expose it.",
    phrases: [
      {
        ja: "正直に申{もう}し上{あ}げると、まだ使ったことがありません。",
        en: "To be honest, I haven't used it yet.",
      },
      {
        ja: "実務での経験はありませんが、仕組みは理解しています。",
        en: "I have no professional experience with it, but I understand how it works.",
      },
      { ja: "近い経験としては、〜があります。", en: "The closest experience I have is ~." },
      {
        ja: "私の理解では〜ですが、違っていたら教えてください。",
        en: "My understanding is ~, but please correct me if I'm wrong.",
      },
      {
        ja: "推測になりますが、お答えしてもよろしいでしょうか。",
        en: "It would be a guess. May I still answer?",
      },
      {
        ja: "その点は存{ぞん}じ上{あ}げません。調べ方なら説明できます。",
        en: "I don't know that. I can explain how I would find out, though.",
      },
      {
        ja: "入社までに、キャッチアップしておきます。",
        en: "I'll catch up on it before I start.",
      },
    ],
  },
  {
    id: "honest-scope",
    title: { ja: "正直に範囲を伝える", en: "Stating scope honestly" },
    intro:
      "The vocabulary of what is built, what is local, and what is only designed. Use these whenever you describe ReelWalk's AWS, Argo CD or splat work.",
    phrases: [
      { ja: "ここまでは、実際に動かして確認しました。", en: "Up to this point, I've actually run it and checked." },
      {
        ja: "ここから先は設計だけで、まだ検証{けんしょう}していません。",
        en: "Beyond this it's design only; I haven't verified it yet.",
      },
      { ja: "ローカル環境では確認済みです。", en: "It's confirmed in a local environment." },
      { ja: "本番環境での運用経験は、まだありません。", en: "I don't have experience running it in production yet." },
      {
        ja: "一人で開発したので、チームでの運用は未経験です。",
        en: "I built it alone, so I haven't operated it as a team.",
      },
      {
        ja: "コードはAIツールの支援を受けて書きましたが、設計は自分で決めました。",
        en: "I wrote the code with help from AI tools, but I made the design decisions.",
      },
      {
        ja: "この数字は私の環境で測ったもので、目安です。",
        en: "These numbers were measured on my machine; treat them as a rough guide.",
      },
      {
        ja: "ADRに「未検証{みけんしょう}」と明記{めいき}しています。",
        en: "I've explicitly marked it as unverified in the ADR.",
      },
    ],
  },
  {
    id: "star",
    title: { ja: "経験を話す（STAR）", en: "Telling an experience (STAR)" },
    intro:
      "Situation, Task, Action, Result, then the lesson. These connectors keep a story short and in order. One sentence per step is enough.",
    phrases: [
      { ja: "当時は、〜という状況でした。", en: "At the time, the situation was ~.", when: "Situation" },
      { ja: "私の役割は、〜でした。", en: "My role was ~.", when: "Task" },
      { ja: "そこで、まず〜しました。", en: "So first, I ~.", when: "Action" },
      { ja: "次に、〜を試しました。", en: "Next, I tried ~.", when: "Action" },
      { ja: "その結果、〜になりました。", en: "As a result, ~.", when: "Result" },
      { ja: "数字で言うと、〜ほど改善しました。", en: "In numbers, it improved by about ~.", when: "Result" },
      { ja: "この経験から、〜を学びました。", en: "From this I learned ~.", when: "Lesson" },
      {
        ja: "今、振{ふ}り返{かえ}ると、〜すればよかったと思います。",
        en: "Looking back, I should have ~.",
        when: "Reflection",
      },
    ],
  },
  {
    id: "opinion",
    title: { ja: "意見を述べる・比較する", en: "Giving opinions and comparing" },
    intro:
      "For design questions: state a position, give reasons, name the trade-off, and say what would change your mind. Hedged but decisive.",
    phrases: [
      { ja: "私としては、〜がよいと考えます。", en: "Personally, I think ~ is better." },
      { ja: "理由は二つあります。", en: "There are two reasons." },
      { ja: "AとBを比べると、Aのほうが〜です。", en: "Comparing A and B, A is more ~." },
      { ja: "一方で、Bには〜という利点があります。", en: "On the other hand, B has the advantage of ~." },
      { ja: "トレードオフとしては、〜が挙{あ}げられます。", en: "As a trade-off, there's ~." },
      { ja: "規模が小さいうちは、〜で十分だと思います。", en: "While the scale is small, ~ is enough, I think." },
      { ja: "状況によりますが、私なら〜を選びます。", en: "It depends on the situation, but I would choose ~." },
      { ja: "〜という前提{ぜんてい}であれば、〜です。", en: "If we assume ~, then ~." },
    ],
  },
  {
    id: "connectors",
    title: { ja: "技術説明のつなぎ言葉", en: "Connectors for technical explanations" },
    intro:
      "Signposts let the listener follow a long explanation. Lean on them when your vocabulary runs short: the structure carries the meaning.",
    phrases: [
      { ja: "まず、全体像からご説明します。", en: "First, let me give you the big picture." },
      { ja: "次に、〜について説明します。", en: "Next, I'll explain ~." },
      { ja: "具体的には、〜です。", en: "Specifically, ~." },
      { ja: "例えば、〜。", en: "For example, ~." },
      { ja: "一方で、〜。", en: "On the other hand, ~." },
      { ja: "つまり、〜ということです。", en: "In other words, ~." },
      { ja: "言い換えると、〜。", en: "To put it another way, ~." },
      { ja: "そのため、〜。", en: "Because of that, ~." },
      { ja: "補足すると、〜。", en: "To add to that, ~." },
      { ja: "以上が、〜の流れです。", en: "That's the flow of ~." },
    ],
  },
  {
    id: "greetings",
    title: { ja: "面接の始まりと終わりの挨拶", en: "Opening and closing the interview" },
    intro:
      "Fixed phrases for the first and last minute. Say them slowly; first and last impressions carry the most weight.",
    phrases: [
      { ja: "本日はお時間をいただき、ありがとうございます。", en: "Thank you for your time today.", when: "Opening" },
      { ja: "【氏名】と申{もう}します。本日はよろしくお願いいたします。", en: "I'm 【name】. Thank you for today.", when: "Opening" },
      { ja: "画面を共有してもよろしいでしょうか。", en: "May I share my screen?", when: "Before a demo" },
      { ja: "以上です。", en: "That's all.", when: "To mark the end of an answer" },
      {
        ja: "今後の選考の流れについて、伺{うかが}ってもよろしいでしょうか。",
        en: "May I ask about the next steps in the process?",
        when: "Near the end",
      },
      {
        ja: "本日は貴重なお時間をいただき、ありがとうございました。",
        en: "Thank you very much for your valuable time today.",
        when: "Closing",
      },
      { ja: "ご連絡をお待ちしております。", en: "I look forward to hearing from you.", when: "Closing" },
      { ja: "失礼いたします。", en: "Goodbye. (Excuse me.)", when: "Leaving the room or the call" },
    ],
  },
  {
    id: "online-trouble",
    title: { ja: "オンライン面接のトラブル", en: "Online interview trouble" },
    intro:
      "If any round is online. Name the problem, propose a fix, then pick up where you left off. Calm handling of a glitch is itself a good impression.",
    phrases: [
      { ja: "申{もう}し訳{わけ}ありません、音声が途切{とぎ}れてしまいました。", en: "I'm sorry, the audio cut out." },
      { ja: "私の声は聞こえていますでしょうか。", en: "Can you hear me?" },
      { ja: "画面が止まってしまったようです。", en: "The screen seems to have frozen." },
      { ja: "一度、退出{たいしゅつ}して、すぐに入り直します。", en: "I'll leave and rejoin right away." },
      { ja: "お手数ですが、チャットに書いていただけますか。", en: "Sorry for the trouble, but could you type it in the chat?" },
      {
        ja: "回線が不安定なので、カメラをオフにしてもよろしいでしょうか。",
        en: "My connection is unstable. May I turn off my camera?",
      },
      {
        ja: "失礼しました。どこまでお話ししたか、確認してもよろしいですか。",
        en: "Sorry about that. May I check where I left off?",
      },
      { ja: "画面共有は見えていますでしょうか。", en: "Can you see my shared screen?" },
    ],
  },
];
