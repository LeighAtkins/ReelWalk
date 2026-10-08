import type { Line, QA } from "../lib/types";

/**
 * The next round: an interview with the PO/manager of the team that builds
 * the shipping-management and internal web systems (1 PO + 2 developers;
 * they want a developer who later becomes a PO). Source: notes from the
 * second interview, 2026-10-08. Plain N2 Japanese, furigana only above N2.
 * Lines with 【】 need the candidate's own facts.
 */

export const MANAGER_QA: QA[] = [
  {
    q: { ja: "今のお仕事について、教えてください。", en: "Tell me about your current job." },
    a: [
      { ja: "オーダーメイドのソファカバーを作る会社で、カスタマーサポートを担当しています。", en: "I work in customer support at a company that makes made-to-order sofa covers." },
      { ja: "お客様の質問に答えたり、ソファのサイズを確認して、生産チームに伝えたりしています。", en: "I answer customers' questions, check sofa measurements and pass them on to the production team." },
      { ja: "プログラミングの知識を生{い}かして、仕事で使うツールも作っています。", en: "I also use my programming skills to build tools we use at work." },
    ],
    tip: "Keep it to three sentences, then let them ask. The tools are the hook for the next question.",
  },
  {
    q: { ja: "OMNOMSについて、詳しく教えてください。", en: "Tell me more about OMNOMS." },
    a: [
      { ja: "会社で新しい注文管理システムを使い始めましたが、保存のたびにページが全部更新されて、大変でした。", en: "We started using a new order-management system, but every save reloaded the whole page, which was painful." },
      { ja: "開発チームは移行で忙しかったので、サポートチームの困りごとを聞いて、ブラウザの拡張機能を作りました。", en: "The dev team was busy with the migration, so I asked the support team what slowed them down and built a browser extension." },
      { ja: "ページを更新せずに保存できて、他のツールもワンクリックで開けます。", en: "It saves without reloading, and opens the other tools in one click." },
      { ja: "生産チームへのメールの下書きも作りますが、送る前に必ず人が確認します。", en: "It also drafts the email to the production team, but a person always checks it before it's sent." },
    ],
    tip: "This is your best story for a team that builds admin systems: you were the user, you listened, you built it, and you kept a human check.",
  },
  {
    q: { ja: "お客様や社内の要望は、どのように整理しますか。", en: "How do you organise requests from customers or colleagues?" },
    a: [
      { ja: "まず、使う人に、何に一番困っているかを聞きます。", en: "First I ask the people who use it what bothers them most." },
      { ja: "次に、一番大きい問題から、小さく作って見てもらいます。", en: "Then I start with the biggest problem, build something small and show it to them." },
      { ja: "意見をもらって直しながら、少しずつ広げます。", en: "I fix it based on their feedback and grow it step by step." },
    ],
    tip: "This is the PO question in disguise. Mention that you check back with users, not just build.",
  },
  {
    q: { ja: "将来、POになりたいと思いますか。", en: "Would you like to become a PO in the future?" },
    a: [
      { ja: "はい、挑戦{ちょうせん}したいです。", en: "Yes, I'd like to try." },
      { ja: "今の仕事でも、使う人の困りごとを聞いて、解決する方法を考えています。", en: "Even now, I listen to users' problems and think about how to solve them." },
      { ja: "まずは開発者としてシステムをよく理解して、それから使う人と開発チームをつなぐ仕事がしたいです。", en: "First I want to understand the system well as a developer, then connect the users and the development team." },
    ],
    tip: "They are hiring for this path. Sound keen but grounded: developer first, PO later.",
  },
  {
    q: { ja: "ほかの人が書いたコードは、どうやって理解しますか。", en: "How do you get to know code someone else wrote?" },
    a: [
      { ja: "まず動かしてみて、画面とデータの流れを確認します。", en: "First I run it and follow the screens and the data flow." },
      { ja: "テストや小さい修正から始めて、少しずつ慣れます。", en: "I start with tests and small fixes and get used to it bit by bit." },
      { ja: "わからないことは、一人で悩まずに早めに聞きます。", en: "If I don't understand something, I ask early instead of struggling alone." },
    ],
    tip: "The job is maintenance and development of an existing tool. 'I ask early' matters to a small team.",
  },
  {
    q: { ja: "チームで意見が違ったら、どうしますか。", en: "What do you do when the team disagrees?" },
    a: [
      { ja: "まず、相手の理由を最後まで聞きます。", en: "First I listen to the other person's reasons all the way through." },
      { ja: "それから、データや試した結果を見ながら話します。", en: "Then we talk, looking at data or the results of trying it." },
      { ja: "チームで決まったことには、気持ちよく従います。", en: "Once the team decides, I go along with it willingly." },
    ],
  },
  {
    q: { ja: "失敗した経験と、そこから学んだことを教えてください。", en: "Tell me about a mistake and what you learned." },
    a: [
      { ja: "ReelWalkで、編集画面が固まる不具合がありました。", en: "In ReelWalk, there was a bug that froze the editor." },
      { ja: "原因を調べると、入力のチェックで、小さい数のエラーが起きていました。", en: "When I looked into it, the input check was failing on a small decimal number." },
      { ja: "直したあと、同じエラーが起きても画面が止まらないようにしました。", en: "After fixing it, I made sure the screen keeps working even if the same error happens again." },
    ],
    tip: "Real bug from 2026-10-07: a ZodError on fractional milliseconds froze the editor; the history reducer now drops rejected edits.",
  },
  {
    q: { ja: "自動化した経験はありますか。", en: "Have you automated anything?" },
    a: [
      { ja: "はい。OMNOMSで、生産チームへのメールの下書きを自動で作れるようにしました。", en: "Yes. With OMNOMS, the email draft to the production team is created automatically." },
      { ja: "ReelWalkでは、テストやスキャン、デプロイの準備をCIで自動にしています。", en: "In ReelWalk, CI automates the tests, the scans and getting a deploy ready." },
      { ja: "ただ、大事なところは、最後に人が確認するようにしています。", en: "But for the important parts, a person still checks at the end." },
    ],
    tip: "Their notes say many people there love automation. The human check shows judgment.",
  },
  {
    q: { ja: "なぜ、受託開発の会社を選びましたか。", en: "Why a company that does contract development?" },
    a: [
      { ja: "いろいろなお客様の課題{かだい}を、技術で解決できるからです。", en: "Because I can solve different customers' problems with technology." },
      { ja: "今の仕事でも、お客様の話を聞いて、正しく伝えることを大切にしています。", en: "In my current job, too, I care about listening to customers and passing things on accurately." },
      { ja: "その経験は、要望を聞いて設計する仕事に生かせると思います。", en: "I think that experience will help in work where you listen to requests and design the solution." },
    ],
  },
  {
    q: { ja: "契約社員での採用になりますが、大丈夫ですか。", en: "The position starts as a contract employee. Is that OK?" },
    a: [
      { ja: "はい、理解しています。", en: "Yes, I understand." },
      { ja: "まずは契約社員として結果を出して、将来は正社員も目指したいです。", en: "I want to show results as a contract employee first, and aim for a full-time position later." },
    ],
    tip: "Notes: first contract 3 months, then 6-month renewals with no limit; you can ask for a full-employee interview.",
  },
  {
    q: { ja: "神田のオフィスに出社できますか。", en: "Can you come into the Kanda office?" },
    a: [
      { ja: "はい、【出社について、正直な答え：例えば、毎日出社できます。家から〇分です】", en: "Yes, 【your honest answer: e.g. I can come in every day; it's ○ minutes from home】" },
    ],
    tip: "Office only, no remote. Decide your exact answer before the call.",
  },
  {
    q: { ja: "最近、どんなことを勉強していますか。", en: "What have you been studying recently?" },
    a: [
      { ja: "KubernetesとAWSです。ReelWalkを実際にEKSで動かしてから、コストを比べて構成を変えました。", en: "Kubernetes and AWS. I actually ran ReelWalk on EKS, then compared costs and changed the setup." },
      { ja: "【サバイバルTypeScriptで読んだ章と、参考になったこと】", en: "【The chapter of Survival TypeScript you read, and what you found useful】" },
      { ja: "将来は、CKADも取りたいと思っています。", en: "In the future I'd also like to get the CKAD." },
    ],
    tip: "Only say the サバイバルTypeScript line if you have read that chapter. The CKAD line only if you mean it.",
  },
];

/** Questions to ask the PO/manager at the end. */
export const MANAGER_ASK: Line[] = [
  { ja: "出荷管理のシステムは、どんな方が、どんな場面で使っていますか。", en: "Who uses the shipping system, and in what situations?" },
  { ja: "お客様からの要望は、どのように集めて、優先順位を決めていますか。", en: "How do you collect customer requests and decide priorities?" },
  { ja: "今、チームで一番改善したいことは何ですか。", en: "What does the team most want to improve right now?" },
  { ja: "POになるための社内試験では、どんなことが求められますか。", en: "What does the internal exam for becoming a PO require?" },
  { ja: "最初の3か月で、どんな成果を期待されていますか。", en: "What results would you expect in the first three months?" },
  { ja: "正社員の面接は、どのタイミングで相談できますか。", en: "When could I ask about an interview for a full-time position?" },
];

/** How to listen in a Japanese interview: the second-interview feedback was "the aizuchi comes a little early". */
export const AIZUCHI: Line[] = [
  { ja: "はい、ありがとうございます。", en: "Yes, thank you. (after they finish, then answer)" },
  { ja: "少し考えてもよろしいでしょうか。", en: "May I think for a moment?" },
  { ja: "つまり、〜ということでしょうか。", en: "So, do you mean …?" },
];
