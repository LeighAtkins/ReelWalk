import type { Topic } from "../lib/types";

/**
 * Async rendering (SQS, the worker, job states, idempotency, retries) and the
 * AWS services around it. Every claim here was checked against the repo:
 * the worker really runs against ElasticMQ and MinIO locally; CloudFront,
 * CloudWatch, IAM roles and Bedrock are designed or planned, never deployed.
 */
export const asyncTopics: Topic[] = [
  // ── SQS ─────────────────────────────────────────────────────────
  {
    id: "sqs",
    group: "async",
    name: "SQS",
    ja: "ジョブの待ち行列{ぎょうれつ}",
    say: "エスキューエス",
    oneLiner: {
      ja: "Webからワーカーへ、レンダーの仕事を渡すキューです。",
      en: "The queue that hands render jobs from the web app to the workers.",
    },
    explain: [
      { ja: "動画のレンダーは、数分かかることがあります。", en: "Rendering a video can take several minutes." },
      { ja: "なので、Webのリクエストの中では処理しません。", en: "So we don't do it inside a web request." },
      {
        ja: "WebはジョブをDBに書いてから、SQSにメッセージを送ります。",
        en: "The web app writes the job to the database, then sends a message to SQS.",
      },
      {
        ja: "メッセージの中身は、jobIdとgenerationだけです。",
        en: "The message carries only the jobId and the generation.",
      },
      {
        ja: "ワーカーはロングポーリングで、最大10秒待って受け取ります。",
        en: "Workers receive with long polling, waiting up to 10 seconds.",
      },
      {
        ja: "受け取ったメッセージは、可視性{かしせい}タイムアウトの間、見えなくなります。",
        en: "A received message stays invisible for the visibility timeout.",
      },
      {
        ja: "これが実質的{じっしつてき}に、ジョブのリースになります。",
        en: "That effectively works as a lease on the job.",
      },
      {
        ja: "ローカルでは、ElasticMQで同じAPIを使っています。",
        en: "Locally, ElasticMQ provides the same API.",
      },
    ],
    why: [
      {
        ja: "最初はRedisのリストで、ワーカーが落ちるとジョブが消えていました。",
        en: "The first version used a Redis list, and a job was lost whenever a worker died.",
      },
      {
        ja: "SQSなら、可視性{かしせい}タイムアウトとDLQが最初からあります。",
        en: "SQS has a visibility timeout and a dead-letter queue out of the box.",
      },
      {
        ja: "その代わり、届くのは「少なくとも一回{いっかい}」なので、重複{ちょうふく}対策が必要です。",
        en: "The trade-off is at-least-once delivery, so duplicates have to be handled.",
      },
      {
        ja: "Postgresをキューにする案もありましたが、長いレンダーとは相性が悪いです。",
        en: "Using Postgres as a queue was an option, but it fits poorly with long renders.",
      },
    ],
    status: "local",
    statusNote:
      "The code uses the real AWS SDK SQS client, but it has only ever run against ElasticMQ (Docker Compose and kind); the Terraform queue is an early sketch with no dead-letter queue and was never applied.",
    inRepo: [
      { path: "apps/web/lib/queue.ts", what: "SendMessage with a body of only { jobId, generation }." },
      { path: "packages/db/src/outbox.ts", what: "The outbox: the message is written with the job in one transaction, then relayed to SQS (FOR UPDATE SKIP LOCKED)." },
      {
        path: "apps/worker/src/index.ts",
        what: "ReceiveMessage with WaitTimeSeconds 10, MaxNumberOfMessages 1 and the visibility timeout.",
      },
      { path: "docker-compose.yml", what: "ElasticMQ config: render-jobs, 120 s visibility, DLQ after 3 receives." },
      { path: "docs/adr/0001-sqs-for-render-jobs.md", what: "Why SQS over a Redis list, Postgres SKIP LOCKED or one Kubernetes Job per render." },
    ],
    terms: [
      { ja: "キュー", en: "queue", note: "Textbooks say 待ち行列; in conversation engineers just say キュー." },
      { ja: "メッセージキュー", en: "message queue" },
      {
        ja: "ロングポーリング",
        en: "long polling",
        note: "WaitTimeSeconds (max 20). Short polling is ショートポーリング.",
      },
      {
        ja: "可視性{かしせい}タイムアウト",
        en: "visibility timeout",
        note: "The official AWS Japanese term. Some people say ビジビリティタイムアウト.",
      },
      { ja: "受信回数{じゅしんかいすう}", en: "receive count", note: "ApproximateReceiveCount in the API." },
      {
        ja: "少なくとも一回{いっかい}の配信{はいしん}",
        en: "at-least-once delivery",
        note: "Also said in English as アットリーストワンス.",
      },
      { ja: "標準{ひょうじゅん}キュー", en: "standard queue", note: "What ReelWalk uses. The other kind is FIFOキュー (ファイフォ)." },
      { ja: "疎結合{そけつごう}", en: "loose coupling", note: "A favourite interview word for why a queue sits between services." },
      { ja: "リース", en: "lease", note: "A time-limited right to work on something." },
    ],
    qa: [
      {
        q: { ja: "なぜSQSを選んだんですか？", en: "Why did you choose SQS?" },
        a: [
          { ja: "レンダーは長くて、途中でプロセスが落ちることもあります。", en: "Renders are long and the process can die halfway." },
          {
            ja: "最初のRedisのリストだと、そのときジョブが消えていました。",
            en: "With the first Redis list, the job was lost when that happened.",
          },
          {
            ja: "SQSは可視性{かしせい}タイムアウトで、落ちても再配信{さいはいしん}されます。",
            en: "With SQS the visibility timeout means the job is redelivered after a crash.",
          },
          { ja: "受信回数とDLQも、自分で作る必要がありません。", en: "I don't have to build receive counts or a DLQ myself." },
        ],
        tip: "They want a reason tied to failure handling, not 'it is the AWS default'. Mention the Redis LPOP version you replaced.",
      },
      {
        q: { ja: "可視性{かしせい}タイムアウトは何秒ですか？", en: "How long is the visibility timeout?" },
        a: [
          { ja: "120秒です。", en: "120 seconds." },
          {
            ja: "レンダー中は、20秒ごとにタイムアウトを延長しています。",
            en: "While rendering, the worker extends it every 20 seconds.",
          },
          {
            ja: "なので、長いレンダーでもメッセージは見えないままです。",
            en: "So the message stays hidden even during a long render.",
          },
          {
            ja: "ワーカーが落ちたら延長が止まり、2分以内に戻ってきます。",
            en: "If the worker dies, extending stops and the message is back within two minutes.",
          },
        ],
        tip: "Show you extend a short timeout (ChangeMessageVisibility) rather than setting one huge timeout; a long fixed timeout means slow recovery after a crash.",
      },
      {
        q: { ja: "FIFOキューは使わないんですか？", en: "Don't you use a FIFO queue?" },
        a: [
          { ja: "使っていません。標準キューです。", en: "No, it is a standard queue." },
          { ja: "順番は、レンダーでは重要ではありません。", en: "Order doesn't matter for renders." },
          {
            ja: "FIFOでも、ワーカーが落ちれば同じメッセージがまた届きます。",
            en: "Even with FIFO, the same message comes back if a worker dies.",
          },
          {
            ja: "なので結局、ワーカー側を冪等{べきとう}にする必要があります。",
            en: "So the worker has to be idempotent in any case.",
          },
        ],
        tip: "FIFO deduplication only covers sends within 5 minutes; it does not stop redelivery after a crash.",
      },
    ],
    videoSearch: ["SQS 入門 解説", "SQS 可視性タイムアウト ロングポーリング", "AWS SQS 非同期処理 設計"],
    docs: [
      {
        title: "Amazon SQS の可視性タイムアウト",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html",
      },
      {
        title: "Amazon SQS のショートポーリングとロングポーリング",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-short-and-long-polling.html",
      },
      { title: "ElasticMQ (GitHub)", url: "https://github.com/softwaremill/elasticmq" },
    ],
    related: ["worker", "idempotency", "retries-dlq", "job-states", "kind", "terraform"],
  },

  // ── Worker ──────────────────────────────────────────────────────
  {
    id: "worker",
    group: "async",
    name: "Render worker",
    ja: "動画を書{か}き出{だ}すワーカー",
    say: "レンダーワーカー",
    oneLiner: {
      ja: "キューからジョブを取り、Remotionで動画を作ってS3に置きます。",
      en: "It takes jobs from the queue, renders the video with Remotion and puts it in S3.",
    },
    explain: [
      { ja: "ワーカーは、Webとは別のNode.jsのプロセスです。", en: "The worker is a Node.js process separate from the web app." },
      { ja: "SQSをロングポーリングして、1件ずつ受け取ります。", en: "It long-polls SQS and receives one message at a time." },
      {
        ja: "まずDBのジョブを見て、処理するかどうか決めます。",
        en: "First it looks at the job row and decides whether to process it.",
      },
      {
        ja: "条件付{じょうけんつ}きのUPDATEで、ジョブをRUNNINGにします。",
        en: "It claims the job by setting it to RUNNING with a conditional UPDATE.",
      },
      {
        ja: "Remotionで、ヘッドレスChromeとffmpegを使って書{か}き出{だ}します。",
        en: "Remotion renders it with headless Chrome and ffmpeg.",
      },
      {
        ja: "20秒ごとに、タイムアウトを延長してハートビートを書きます。",
        en: "Every 20 seconds it extends the timeout and writes a heartbeat.",
      },
      {
        ja: "MP4をS3に上げてSUCCEEDEDにし、メッセージを消します。",
        en: "It uploads the MP4 to S3, sets SUCCEEDED and deletes the message.",
      },
      { ja: "1つのPodでは、同時に1本だけレンダーします。", en: "Each pod renders only one job at a time." },
    ],
    why: [
      {
        ja: "レンダーはメモリを数GB使い、Webとは負荷{ふか}の形が違います。",
        en: "A render uses gigabytes of memory; its load looks nothing like the web app's.",
      },
      {
        ja: "分けておけば、レンダーが落ちてもサイトは止まりません。",
        en: "Kept apart, a crashing render never takes the site down.",
      },
      {
        ja: "1Pod1本なので、メモリの見積{みつ}もりが簡単です。",
        en: "One render per pod makes memory easy to size.",
      },
      {
        ja: "その代わり、処理量はPodの数で増やすしかありません。",
        en: "The trade-off is that throughput only grows by adding pods.",
      },
    ],
    status: "local",
    statusNote:
      "Built and tested (Vitest handler tests, a real render in Playwright); it runs in Docker Compose and as 2 pods on kind against ElasticMQ and MinIO, never on EKS.",
    inRepo: [
      { path: "apps/worker/src/index.ts", what: "Poll loop, /healthz liveness endpoint and SIGTERM handling." },
      { path: "apps/worker/src/handler.ts", what: "handleDelivery: decide, claim, heartbeat, render, succeed or retry." },
      { path: "apps/worker/src/config.ts", what: "Checks heartbeat 20 s < stale 60 s < visibility 120 s at startup." },
      { path: "infra/helm/reelwalk/templates/worker.yaml", what: "Deployment with a 300 s grace period, /dev/shm for Chrome, optional CPU HPA." },
    ],
    terms: [
      { ja: "ワーカー", en: "worker", note: "Also コンシューマー (consumer) when talking about queues." },
      { ja: "書{か}き出{だ}し", en: "export / render", note: "Video people say 書き出し; engineers also say レンダリング." },
      { ja: "ハートビート", en: "heartbeat", note: "A periodic 'I'm still alive' write; here heartbeatAt on the job row." },
      { ja: "延長{えんちょう}", en: "extension", note: "タイムアウトを延長する = extend the timeout." },
      { ja: "取得{しゅとく}", en: "acquire / claim", note: "ジョブを取る is the casual way to say claiming a job." },
      {
        ja: "グレースフルシャットダウン",
        en: "graceful shutdown",
        note: "Stop taking new work, finish the current job, then exit.",
      },
      { ja: "猶予期間{ゆうよきかん}", en: "grace period", note: "terminationGracePeriodSeconds, 300 s for the worker." },
      { ja: "ライブネスプローブ", en: "liveness probe", note: "死活監視{しかつかんし} is the general word for health checking." },
      { ja: "スケールアウト", en: "scale out", note: "Adding pods. 水平{すいへい}スケール means the same." },
    ],
    qa: [
      {
        q: { ja: "レンダー中にワーカーが落ちたら、どうなりますか？", en: "What happens if a worker dies mid-render?" },
        a: [
          { ja: "タイムアウトの延長とハートビートが止まります。", en: "Extending the timeout and the heartbeat both stop." },
          { ja: "120秒後に、メッセージがまた見えるようになります。", en: "After 120 seconds the message becomes visible again." },
          {
            ja: "別のワーカーが受け取り、ハートビートが古いので引き継ぎます。",
            en: "Another worker receives it and takes over, because the heartbeat is stale.",
          },
          {
            ja: "出力は同じキーに上書{うわが}きなので、動画は1本のままです。",
            en: "The output overwrites the same key, so there is still one video.",
          },
        ],
        tip: "Quote the timing chain: heartbeat 20 s < stale 60 s < visibility 120 s. config.ts refuses to start otherwise, so a redelivery is never wasted on a 'defer'.",
      },
      {
        q: { ja: "デプロイ中のレンダーは、どうなりますか？", en: "What happens to a render during a deploy?" },
        a: [
          { ja: "SIGTERMを受けたら、新しいメッセージは取りません。", en: "On SIGTERM it stops taking new messages." },
          { ja: "今のレンダーは、最後まで続けます。", en: "It carries on with the current render." },
          { ja: "猶予{ゆうよ}は300秒にしています。", en: "The grace period is 300 seconds." },
          {
            ja: "間に合わなくても、タイムアウト後に別のPodがやり直します。",
            en: "If it runs out, another pod redoes the job after the timeout.",
          },
        ],
        tip: "This is graceful shutdown plus at-least-once as a safety net. Saying both shows you thought about rollouts, not just happy paths.",
      },
      {
        q: { ja: "なぜ1つのPodで1本だけなんですか？", en: "Why only one render per pod?" },
        a: [
          { ja: "Chromeのレンダーは、メモリをたくさん使います。", en: "Rendering in Chrome uses a lot of memory." },
          { ja: "1本に限れば、リソースの上限を決めやすいです。", en: "Limiting it to one makes resource limits easy to set." },
          { ja: "1本の中では、Chromeのタブを4つ並列で使います。", en: "Inside one render, it uses four Chrome tabs in parallel." },
          {
            ja: "今のHPAはCPUベースなので、キューの長さで増やすのが改善点です。",
            en: "Today's HPA is CPU-based; scaling on queue depth (KEDA) is the planned improvement.",
          },
        ],
        tip: "HPA is off by default in values.yaml and KEDA is only planned. Say 改善点 / 予定, not 使っています.",
      },
    ],
    videoSearch: ["Remotion React 動画生成", "SQS ワーカー 非同期処理", "Kubernetes グレースフルシャットダウン SIGTERM"],
    docs: [
      { title: "Remotion renderMedia()", url: "https://www.remotion.dev/docs/renderer/render-media" },
      {
        title: "ChangeMessageVisibility (Amazon SQS API)",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/APIReference/API_ChangeMessageVisibility.html",
      },
      { title: "Podのライフサイクル (Kubernetes)", url: "https://kubernetes.io/ja/docs/concepts/workloads/pods/pod-lifecycle/" },
    ],
    related: ["sqs", "remotion", "job-states", "idempotency", "kubernetes", "helm", "docker"],
  },

  // ── Job states ──────────────────────────────────────────────────
  {
    id: "job-states",
    group: "async",
    name: "Job state machine",
    ja: "ジョブの状態遷移{じょうたいせんい}",
    say: "ジョブ ステートマシン",
    oneLiner: {
      ja: "ジョブの状態と、許される変化を1つの表で決めています。",
      en: "One table defines a job's states and which changes between them are allowed.",
    },
    explain: [
      {
        ja: "状態は、QUEUED、RUNNING、SUCCEEDED、FAILEDの4つです。",
        en: "There are four states: QUEUED, RUNNING, SUCCEEDED and FAILED.",
      },
      { ja: "作られたらQUEUED、ワーカーが取ったらRUNNINGです。", en: "A new job is QUEUED; once a worker takes it, RUNNING." },
      { ja: "成功したらSUCCEEDED、回数を使い切ったらFAILEDです。", en: "SUCCEEDED on success; FAILED when attempts run out." },
      { ja: "失敗しても回数が残っていれば、QUEUEDに戻します。", en: "If an attempt fails with attempts left, it goes back to QUEUED." },
      { ja: "FAILEDからは、画面で手動リトライができます。", en: "From FAILED, the user can retry by hand in the UI." },
      {
        ja: "許される遷移{せんい}は、packages/coreの表に書いてあります。",
        en: "The allowed transitions are written in a table in packages/core.",
      },
      {
        ja: "更新は、今の状態をWHEREに入れた条件付{じょうけんつ}き更新です。",
        en: "Each update is conditional, with the expected current state in the WHERE clause.",
      },
      {
        ja: "読んでから書くのではないので、競合{きょうごう}が起きません。",
        en: "It isn't a read followed by a write, so there is no race.",
      },
    ],
    why: [
      {
        ja: "表にしておくと、全部の遷移をテストで確認できます。",
        en: "As a table, every transition can be checked in tests.",
      },
      {
        ja: "条件付き更新なら、ロックを長く持たずに排他{はいた}できます。",
        en: "Conditional updates give mutual exclusion without holding a lock for long.",
      },
      {
        ja: "ただ、表と各WHERE句を、手で揃{そろ}えておく必要があります。",
        en: "The catch is that the table and each WHERE clause must be kept in step by hand.",
      },
    ],
    status: "built",
    statusNote:
      "Fully built: the transition table and its tests live in packages/core, and every status write in the worker and the Server Actions is a conditional Prisma updateMany on Postgres.",
    inRepo: [
      { path: "packages/core/src/job-status.ts", what: "The TRANSITIONS table, canTransition and isTerminal." },
      { path: "apps/worker/src/store.ts", what: "claim, heartbeat, succeed, requeue and fail as conditional updateMany calls." },
      { path: "apps/web/app/actions.ts", what: "retryRenderJob: FAILED -> QUEUED and generation + 1 in one write." },
      { path: "packages/core/tests/job-status.test.ts", what: "Vitest tests for legal and illegal transitions." },
    ],
    terms: [
      { ja: "状態遷移{じょうたいせんい}", en: "state transition", note: "遷移 alone is common: 画面遷移 = screen navigation." },
      { ja: "ステートマシン", en: "state machine", note: "状態機械 exists but almost nobody says it." },
      { ja: "条件付{じょうけんつ}き更新{こうしん}", en: "conditional update", note: "UPDATE ... WHERE status = 'QUEUED'." },
      { ja: "競合{きょうごう}", en: "conflict / race", note: "Race condition is 競合状態 or レースコンディション." },
      { ja: "排他制御{はいたせいぎょ}", en: "mutual exclusion / concurrency control" },
      {
        ja: "楽観的{らっかんてき}ロック",
        en: "optimistic locking",
        note: "The reel autosave uses a revision number this way; job claims are the same idea.",
      },
      { ja: "終端状態{しゅうたんじょうたい}", en: "terminal state", note: "SUCCEEDED and FAILED (FAILED can still be retried by hand)." },
      { ja: "世代{せだい}", en: "generation", note: "In speech, ジェネレーション is fine too." },
    ],
    qa: [
      {
        q: {
          ja: "2つのワーカーが同時に同じジョブを取ったら？",
          en: "What if two workers grab the same job at the same time?",
        },
        a: [
          { ja: "取るときは、1つのUPDATE文で行います。", en: "Claiming is a single UPDATE statement." },
          { ja: "条件は、QUEUEDで世代{せだい}が同じ、です。", en: "The condition is: QUEUED and the same generation." },
          { ja: "DBが順番に処理するので、更新できるのは1つだけです。", en: "The database applies them in turn, so only one succeeds." },
          {
            ja: "もう1つは更新件数が0なので、メッセージを残して終わります。",
            en: "The other updates zero rows, leaves the message and stops.",
          },
        ],
        tip: "The key point is that the check and the write are one atomic statement, not SELECT then UPDATE.",
      },
      {
        q: { ja: "なぜRUNNINGからQUEUEDに戻すんですか？", en: "Why go back from RUNNING to QUEUED?" },
        a: [
          { ja: "自動リトライを待っている状態だからです。", en: "Because the job is waiting for an automatic retry." },
          { ja: "画面でも、待っていることが分かります。", en: "The UI can show that it is waiting." },
          {
            ja: "次のワーカーは、QUEUEDのジョブを普通に取れます。",
            en: "The next worker can claim a QUEUED job the normal way.",
          },
        ],
        tip: "Mention that requeue also clears heartbeatAt, so a retried job never looks like it is still being rendered.",
      },
      {
        q: { ja: "SUCCEEDEDのあと、状態は変わりますか？", en: "Can the state change after SUCCEEDED?" },
        a: [
          { ja: "変わりません。終端状態{しゅうたんじょうたい}です。", en: "No. It is a terminal state." },
          {
            ja: "遅れて届いたメッセージは、何もせずに消します。",
            en: "A message that arrives late is simply deleted.",
          },
          { ja: "もう一度書き出すときは、新しいジョブを作ります。", en: "Exporting again creates a new job." },
        ],
      },
    ],
    videoSearch: ["状態遷移 設計 ステートマシン", "楽観的ロック 排他制御 解説", "Prisma updateMany 条件付き更新"],
    docs: [
      {
        title: "Prisma Client API: updateMany",
        url: "https://www.prisma.io/docs/orm/reference/prisma-client-reference#updatemany",
      },
      { title: "PostgreSQL: UPDATE", url: "https://www.postgresql.jp/document/16/html/sql-update.html" },
    ],
    related: ["worker", "idempotency", "retries-dlq", "prisma", "postgresql", "server-actions", "vitest"],
  },

  // ── Idempotency ─────────────────────────────────────────────────
  {
    id: "idempotency",
    group: "async",
    name: "Idempotency",
    ja: "冪等性{べきとうせい}",
    say: "べきとうせい",
    oneLiner: {
      ja: "同じメッセージを何回処理しても、結果は1つになります。",
      en: "However many times a message is processed, there is one result.",
    },
    explain: [
      { ja: "SQSは、少なくとも一回{いっかい}届ける仕組みです。", en: "SQS delivers at least once." },
      { ja: "なので、同じメッセージが2回届くことがあります。", en: "So the same message can arrive twice." },
      { ja: "ワーカーが落ちたときも、同じジョブがまた届きます。", en: "When a worker dies, the same job arrives again too." },
      {
        ja: "そこで、何回処理しても結果が1つになるようにしました。",
        en: "So I made processing give one result no matter how many times it runs.",
      },
      {
        ja: "終わったジョブや、世代{せだい}が古いメッセージは消すだけです。",
        en: "Messages for finished jobs or an old generation are just deleted.",
      },
      {
        ja: "ほかのワーカーが処理中なら、手を出さずに残します。",
        en: "If another worker is rendering it, the message is left alone.",
      },
      {
        ja: "出力のキーはジョブIDで決まるので、上書{うわが}きになります。",
        en: "The output key is derived from the job ID, so a rerun overwrites it.",
      },
      {
        ja: "出力の行もjobIdがユニークで、upsertで書きます。",
        en: "The output row has a unique jobId and is written with an upsert.",
      },
    ],
    why: [
      {
        ja: "ちょうど一回だけ届けるのは、分散{ぶんさん}システムでは難しいです。",
        en: "Exactly-once delivery is hard in a distributed system.",
      },
      {
        ja: "受け取る側を冪等{べきとう}にするのが、一番シンプルです。",
        en: "Making the receiver idempotent is the simplest answer.",
      },
      {
        ja: "その代わり、まれに同じ動画を2回レンダーするコストは受け入れています。",
        en: "The trade-off: occasionally rendering the same video twice, which I accept.",
      },
    ],
    status: "built",
    statusNote:
      "Built and covered by Vitest handler tests (duplicate delivery, stale generation, take-over of a dead worker's job); exercised locally with ElasticMQ, never under production load. Per-claim fencing tokens are not implemented. The transactional outbox is built (ADR 0010) and tested against a real Postgres.",
    inRepo: [
      { path: "packages/core/src/queue.ts", what: "decideDelivery: claim, discard or defer, from the job row and the message generation." },
      { path: "apps/worker/src/store.ts", what: "RenderOutput upsert and status writes conditional on generation." },
      { path: "apps/worker/tests/handler.test.ts", what: "Tests for double delivery, stale generations and stale heartbeats." },
      { path: "docs/adr/0003-separate-idempotent-render-workers.md", what: "The five rules that make a second render harmless." },
    ],
    terms: [
      { ja: "冪等性{べきとうせい}", en: "idempotency", note: "冪等 alone is the adjective: 冪等な処理. Engineers use the kanji word, not a loanword." },
      { ja: "重複{ちょうふく}", en: "duplicate", note: "重複メッセージ, 重複を排除する." },
      { ja: "重複排除{ちょうふくはいじょ}", en: "deduplication", note: "Also 重複除去 or just デデュープ in casual talk." },
      {
        ja: "少なくとも一回{いっかい}",
        en: "at least once",
        note: "Delivery guarantees are often said in English: アットリーストワンス, イグザクトリーワンス.",
      },
      { ja: "上書{うわが}き", en: "overwrite" },
      { ja: "ユニーク制約{せいやく}", en: "unique constraint" },
      { ja: "世代{せだい}", en: "generation", note: "Bumped on each manual retry so old messages can be recognised." },
      { ja: "副作用{ふくさよう}", en: "side effect", note: "Idempotency is about side effects happening once in effect." },
      { ja: "フェンシングトークン", en: "fencing token", note: "Not built here; the planned fix for a zombie worker." },
    ],
    qa: [
      {
        q: { ja: "メッセージの重複{ちょうふく}は、どう防いでいますか？", en: "How do you prevent duplicate messages?" },
        a: [
          { ja: "防ぐのではなく、重複しても困らないようにしています。", en: "I don't prevent them; I make them harmless." },
          { ja: "届いたら、まずDBのジョブの状態と世代を見ます。", en: "On arrival, the worker first checks the job's state and generation." },
          { ja: "もう終わっていれば、メッセージを消すだけです。", en: "If it is already done, it just deletes the message." },
          {
            ja: "2回レンダーしても、出力は同じキーで、DBの行も1つです。",
            en: "Even if it renders twice, the output has the same key and there is one row.",
          },
        ],
        tip: "Reframing 'prevent' as 'make harmless' is exactly what the interviewer hopes to hear for an at-least-once queue.",
      },
      {
        q: {
          ja: "手動リトライのあとに、古いメッセージが届いたら？",
          en: "What if an old message arrives after a manual retry?",
        },
        a: [
          { ja: "リトライのたびに、世代{せだい}を1つ上げています。", en: "Each retry bumps the generation by one." },
          { ja: "メッセージにも、世代が入っています。", en: "The message carries a generation too." },
          { ja: "世代が違えば、古いメッセージとして消します。", en: "If it doesn't match, it is deleted as stale." },
          {
            ja: "リトライ自体も条件付き更新なので、2回押しても1回分です。",
            en: "The retry itself is a conditional update, so tapping twice counts once.",
          },
        ],
      },
      {
        q: { ja: "まだ弱いところはありますか？", en: "Are there still weak spots?" },
        a: [
          {
            ja: "落ちたと判断したワーカーが、実は生きている場合です。",
            en: "When a worker judged dead is actually still alive.",
          },
          { ja: "そのとき、2つのワーカーが同じジョブを書き出せます。", en: "Then two workers can render the same job." },
          { ja: "出力は同じなので、結果は壊れません。", en: "The output is the same, so the result isn't corrupted." },
          {
            ja: "改善するなら、取るたびにトークンを発行してフェンシングします。",
            en: "To improve it, I'd issue a token per claim and fence writes with it.",
          },
          {
            ja: "DB書き込みと送信の間も弱点でしたが、アウトボックスで埋めました。",
            en: "The gap between the DB write and the send was a weak spot too, but I closed it with an outbox.",
          },
        ],
        tip: "Naming a real gap plus a concrete fix beats claiming perfection. Be clear the fencing token is an improvement, not built; the outbox is built (ADR 0010).",
      },
    ],
    videoSearch: ["冪等性 とは 解説", "At-least-once 冪等性 メッセージキュー", "分散システム 重複排除 設計"],
    docs: [
      {
        title: "Amazon SQS 標準キュー: 少なくとも 1 回の配信",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html",
      },
      {
        title: "Amazon Builders' Library: Making retries safe with idempotent APIs",
        url: "https://aws.amazon.com/builders-library/making-retries-safe-with-idempotent-APIs/",
      },
    ],
    related: ["sqs", "worker", "job-states", "retries-dlq", "s3", "prisma"],
  },

  // ── Retries & DLQ ───────────────────────────────────────────────
  {
    id: "retries-dlq",
    group: "async",
    name: "Retries & DLQ",
    ja: "再試行{さいしこう}とデッドレターキュー",
    say: "リトライ、ディーエルキュー",
    oneLiner: {
      ja: "失敗したら間隔を空けてやり直し、3回でDLQに送ります。",
      en: "A failure is retried with growing gaps, and after 3 tries goes to the DLQ.",
    },
    explain: [
      { ja: "レンダーが失敗しても、すぐには諦{あきら}めません。", en: "When a render fails, it doesn't give up right away." },
      { ja: "ジョブをQUEUEDに戻し、メッセージは消さずに残します。", en: "The job goes back to QUEUED and the message is kept." },
      { ja: "可視性{かしせい}タイムアウトを、待ち時間として使います。", en: "The visibility timeout is used as the wait." },
      {
        ja: "待ち時間は15秒、30秒と倍になる、指数{しすう}バックオフです。",
        en: "The wait doubles, 15 s then 30 s: exponential backoff.",
      },
      { ja: "3回目も失敗したら、ジョブをFAILEDにします。", en: "If the third attempt fails, the job is set to FAILED." },
      {
        ja: "次の受信で上限を超えるので、SQSがDLQに移します。",
        en: "The next receive exceeds the limit, so SQS moves it to the DLQ.",
      },
      {
        ja: "DLQを読むループが、残ったジョブをFAILEDにします。",
        en: "A loop reading the DLQ fails any job still left active.",
      },
      { ja: "FAILEDのジョブは、画面から手動でリトライできます。", en: "A FAILED job can be retried by hand from the UI." },
    ],
    why: [
      { ja: "一時的{いちじてき}な失敗は、少し待てば直ることが多いです。", en: "Temporary failures often fix themselves after a short wait." },
      {
        ja: "DLQがあれば、壊れたメッセージが永遠に回りません。",
        en: "With a DLQ, a broken message doesn't loop forever.",
      },
      {
        ja: "ただ、最大回数をワーカーとキューの2か所で揃{そろ}える必要があります。",
        en: "But the max count has to match in two places: the worker and the queue.",
      },
      { ja: "ジッターはまだないので、そこは改善点です。", en: "There's no jitter yet; that is an improvement to make." },
    ],
    status: "local",
    statusNote:
      "Backoff retries, the 3-receive redrive and the DLQ consumer are built and tested, and run against ElasticMQ's dead-letter queue locally; the real SQS redrive policy is not in Terraform yet.",
    inRepo: [
      { path: "packages/core/src/queue.ts", what: "retryDelaySeconds, decideFailure and shouldFailFromDeadLetter." },
      { path: "apps/worker/src/handler.ts", what: "Requeue with extend(delay), extend(0) on the last attempt, handleDeadLetter." },
      { path: "docker-compose.yml", what: "ElasticMQ deadLettersQueue with maxReceiveCount = 3." },
      { path: "apps/web/app/actions.ts", what: "retryRenderJob, the manual retry from the UI." },
    ],
    terms: [
      { ja: "リトライ", en: "retry", note: "再試行 is the written form; in speech リトライ is far more common." },
      { ja: "指数{しすう}バックオフ", en: "exponential backoff", note: "エクスポネンシャルバックオフ is also heard." },
      { ja: "ジッター", en: "jitter", note: "Random spread on the wait so clients don't retry in sync." },
      {
        ja: "デッドレターキュー",
        en: "dead-letter queue",
        note: "Usually just DLQ (ディーエルキュー).",
      },
      { ja: "最大受信回数{さいだいじゅしんかいすう}", en: "max receive count", note: "maxReceiveCount in the redrive policy." },
      { ja: "リドライブ", en: "redrive", note: "Moving messages to, or back from, the DLQ." },
      { ja: "ポイズンメッセージ", en: "poison message", note: "A message that fails every time, e.g. unparseable JSON." },
      { ja: "一時的{いちじてき}な障害{しょうがい}", en: "transient failure" },
      { ja: "手動{しゅどう}リトライ", en: "manual retry" },
      { ja: "諦{あきら}める", en: "to give up" },
    ],
    qa: [
      {
        q: { ja: "リトライは、何回、どんな間隔ですか？", en: "How many retries, and at what intervals?" },
        a: [
          { ja: "全部で3回までです。", en: "Up to three attempts in total." },
          { ja: "間隔は15秒、30秒と倍にしています。", en: "The gap doubles: 15 seconds, then 30." },
          { ja: "上限は15分です。", en: "It is capped at 15 minutes." },
          {
            ja: "待ちは、メッセージの可視性{かしせい}タイムアウトで作っています。",
            en: "The wait is made with the message's visibility timeout.",
          },
        ],
        tip: "A neat detail: no scheduler is needed; ChangeMessageVisibility hides the message for exactly the backoff.",
      },
      {
        q: {
          ja: "ワーカーが毎回落ちて、FAILEDを書けなかったら？",
          en: "What if the worker dies every time and never writes FAILED?",
        },
        a: [
          { ja: "例えば、メモリ不足でPodが毎回落ちる場合ですね。", en: "Say the pod is killed for running out of memory every time." },
          { ja: "3回受信されたら、メッセージはDLQに移ります。", en: "After three receives, the message moves to the DLQ." },
          {
            ja: "ワーカーはDLQも読んでいて、ジョブがまだ動いていればFAILEDにします。",
            en: "The worker also reads the DLQ and fails the job if it still looks active.",
          },
          { ja: "なので、RUNNINGのまま残ることはありません。", en: "So a job never stays RUNNING forever." },
        ],
        tip: "This case is the reason the DLQ consumer exists. It is tested in apps/worker/tests/handler.test.ts.",
      },
      {
        q: { ja: "リトライで、かえって負荷が上がりませんか？", en: "Couldn't retries make the load worse?" },
        a: [
          { ja: "回数を3回に限っているので、無限には増えません。", en: "Attempts are limited to three, so it can't grow without bound." },
          { ja: "間隔も倍にしているので、すぐには集中しません。", en: "The gap doubles, so retries don't pile up at once." },
          {
            ja: "ただ、ジッターがないので、同時に失敗すると揃ってしまいます。",
            en: "But with no jitter, jobs that fail together retry together.",
          },
          { ja: "ここはランダムな幅を足して改善したいです。", en: "I'd improve that by adding a random spread." },
        ],
      },
    ],
    videoSearch: ["デッドレターキュー SQS 解説", "指数バックオフ ジッター リトライ", "SQS リトライ 設計 DLQ"],
    docs: [
      {
        title: "Amazon SQS でのデッドレターキューの使用",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html",
      },
      {
        title: "Amazon Builders' Library: Timeouts, retries and backoff with jitter",
        url: "https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/",
      },
    ],
    related: ["sqs", "worker", "job-states", "idempotency", "cloudwatch"],
  },

  // ── CloudFront ──────────────────────────────────────────────────
  {
    id: "cloudfront",
    group: "aws",
    name: "CloudFront",
    ja: "動画の配信{はいしん}（CDN）",
    say: "クラウドフロント",
    oneLiner: {
      ja: "完成した動画を、近くのエッジから速く届けるCDNです。",
      en: "A CDN that delivers finished videos quickly from a nearby edge.",
    },
    explain: [
      { ja: "CloudFrontは、AWSのCDNです。", en: "CloudFront is AWS's CDN." },
      { ja: "世界中のエッジから、動画を速く届けられます。", en: "It can deliver video fast from edges around the world." },
      { ja: "今は、S3の署名付{しょめいつ}きURLで動画を返しています。", en: "Today the app returns videos as S3 presigned URLs." },
      {
        ja: "環境変数を設定すれば、CloudFrontのURLに切り替わります。",
        en: "Setting an environment variable switches to CloudFront URLs.",
      },
      {
        ja: "本番では、OACでS3を非公開{ひこうかい}のままにする設計です。",
        en: "In production the design keeps S3 private by using OAC.",
      },
      {
        ja: "見る人の制限は、署名付きURLか署名付きCookieでします。",
        en: "Who can watch is controlled with signed URLs or signed cookies.",
      },
      { ja: "ただ、これは設計だけで、まだデプロイしていません。", en: "But this is only a design; it hasn't been deployed." },
    ],
    why: [
      {
        ja: "動画は大きいので、S3から直接だと遅くて高くなります。",
        en: "Videos are large, so serving straight from S3 is slower and costlier.",
      },
      {
        ja: "出力のキーはジョブごとに変わらないので、長くキャッシュできます。",
        en: "Each job's output key never changes, so it can be cached for a long time.",
      },
      {
        ja: "その代わり、署名の鍵やOACなど、設定が増えます。",
        en: "The trade-off is more setup: signing keys, OAC and so on.",
      },
    ],
    status: "designed",
    statusNote:
      "Designed only: Terraform has a bare CloudFront distribution (no OAC, no signed URLs) that was never applied, and the app serves S3/MinIO presigned GET URLs unless CLOUDFRONT_BASE_URL is set, in which case the URL is unsigned.",
    inRepo: [
      { path: "infra/terraform/main.tf", what: "Early aws_cloudfront_distribution sketch in front of the media bucket." },
      { path: "apps/web/lib/storage.ts", what: "mediaUrl: CloudFront when CLOUDFRONT_BASE_URL is set, otherwise a presigned GET." },
      { path: "docs/adr/0005-local-kubernetes-before-eks.md", what: "Lists CloudFront among things kind does not cover." },
    ],
    terms: [
      { ja: "CDN", en: "content delivery network", note: "Say シーディーエヌ." },
      { ja: "配信{はいしん}", en: "delivery / distribution", note: "動画配信 = video delivery or streaming." },
      { ja: "エッジロケーション", en: "edge location", note: "Often just エッジ." },
      { ja: "オリジン", en: "origin", note: "Here the S3 bucket." },
      { ja: "キャッシュ", en: "cache" },
      { ja: "OAC", en: "Origin Access Control", note: "Say オーエーシー. Replaces the older OAI (オーエーアイ)." },
      { ja: "署名付{しょめいつ}きURL", en: "signed / presigned URL", note: "S3 calls it 署名付きURL too." },
      { ja: "有効期限{ゆうこうきげん}", en: "expiry", note: "The app's presigned URLs last one hour." },
      { ja: "非公開{ひこうかい}", en: "private (not public)" },
      { ja: "無効化{むこうか}", en: "invalidation", note: "インバリデーション is also used for cache clearing." },
    ],
    qa: [
      {
        q: { ja: "完成した動画は、どうやって届けていますか？", en: "How do finished videos reach the user?" },
        a: [
          { ja: "今は、S3の署名付{しょめいつ}きURLを返しています。", en: "Right now the app returns an S3 presigned URL." },
          { ja: "ローカルでは、S3の代わりにMinIOです。", en: "Locally MinIO stands in for S3." },
          {
            ja: "AWSでは、前にCloudFrontを置く設計にしました。",
            en: "On AWS, I designed it with CloudFront in front.",
          },
          {
            ja: "ただ、アカウントの都合で、まだデプロイはしていません。",
            en: "But because of the AWS account, it hasn't been deployed yet.",
          },
        ],
        tip: "Be upfront that CloudFront is designed, not run. 設計しました is honest; 運用しています would not be.",
      },
      {
        q: { ja: "OACと署名付きURLは、何が違いますか？", en: "How do OAC and signed URLs differ?" },
        a: [
          { ja: "OACは、CloudFrontからS3への権限です。", en: "OAC is CloudFront's permission to read S3." },
          { ja: "S3を非公開にしたまま、CloudFrontだけが読めます。", en: "S3 stays private and only CloudFront can read it." },
          { ja: "署名付きURLは、見る人への制限です。", en: "A signed URL limits the viewer." },
          { ja: "誰が、いつまで見られるかを決めます。", en: "It decides who can watch, and until when." },
        ],
        tip: "They protect different hops: OAC is CloudFront to S3, signed URLs are viewer to CloudFront. Production would use both.",
      },
      {
        q: { ja: "キャッシュの更新は、どうしますか？", en: "How would you refresh the cache?" },
        a: [
          { ja: "出力のキーは、ジョブIDから作っています。", en: "The output key is built from the job ID." },
          { ja: "成功したジョブの動画は、もう変わりません。", en: "A succeeded job's video never changes." },
          { ja: "新しく書き出すと、新しいジョブとキーになります。", en: "A new export means a new job and a new key." },
          { ja: "なので、無効化{むこうか}はほとんど要りません。", en: "So invalidation is almost never needed." },
        ],
      },
    ],
    videoSearch: ["CloudFront 入門 解説", "CloudFront OAC S3 署名付きURL", "CDN 仕組み 解説"],
    docs: [
      {
        title: "Amazon S3 オリジンへのアクセスの制限 (OAC)",
        url: "https://docs.aws.amazon.com/ja_jp/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html",
      },
      {
        title: "署名付き URL の使用",
        url: "https://docs.aws.amazon.com/ja_jp/AmazonCloudFront/latest/DeveloperGuide/private-content-signed-urls.html",
      },
    ],
    related: ["s3", "terraform", "iam-secrets", "nextjs", "eks"],
  },

  // ── Bedrock ─────────────────────────────────────────────────────
  {
    id: "bedrock",
    group: "aws",
    name: "Bedrock",
    ja: "生成{せいせい}AIの提案",
    say: "ベッドロック",
    oneLiner: {
      ja: "キャプションの下書{したが}きをAIで作る予定です。まだ作っていません。",
      en: "The plan is AI-drafted captions. It hasn't been built.",
    },
    explain: [
      { ja: "Bedrockは、AWSの生成{せいせい}AIのサービスです。", en: "Bedrock is AWS's generative AI service." },
      { ja: "ClaudeなどのモデルをAPIで呼べます。", en: "You can call models such as Claude through an API." },
      { ja: "ReelWalkでは、AI機能はまだ作っていません。", en: "ReelWalk has no AI features yet." },
      { ja: "考えているのは、キャプションの下書{したが}きです。", en: "What I have in mind is drafting captions." },
      { ja: "物件の情報から、Instagram用の文章を提案します。", en: "It would suggest Instagram text from the listing details." },
      {
        ja: "呼び出しはワーカー側で、非同期{ひどうき}にするつもりです。",
        en: "I'd make the call from the worker, asynchronously.",
      },
      { ja: "結果は提案として見せて、必ず人が確認します。", en: "The result is shown as a suggestion and always checked by a person." },
    ],
    why: [
      {
        ja: "キャプションを書くのは、不動産{ふどうさん}の担当者には手間です。",
        en: "Writing captions is a chore for real-estate agents.",
      },
      {
        ja: "Bedrockなら、AWSの中でIAMで権限を管理できます。",
        en: "With Bedrock, access is managed with IAM inside AWS.",
      },
      {
        ja: "ただ、住宅{じゅうたく}の広告は表現のルールが厳しいので、確認が必須です。",
        en: "But housing ads have strict wording rules, so review is a must.",
      },
    ],
    status: "designed",
    statusNote:
      "Not built at all: there is no AI code or Bedrock call in the repo, only a one-line 'Bedrock captions are planned' note in docs/ARCHITECTURE.md; nothing beyond this outline is designed.",
    inRepo: [
      { path: "docs/ARCHITECTURE.md", what: "Known gaps: 'No AI features yet (Bedrock captions are planned)'." },
      { path: "packages/core/src/instagram.ts", what: "Caption limits a generated caption would have to pass." },
      { path: "packages/core/src/vibes.ts", what: "Today's caption text comes from data per vibe, with the housing-ad rule." },
    ],
    terms: [
      { ja: "生成{せいせい}AI", en: "generative AI" },
      { ja: "基盤{きばん}モデル", en: "foundation model", note: "Also ファウンデーションモデル." },
      { ja: "プロンプト", en: "prompt" },
      { ja: "推論{すいろん}", en: "inference", note: "モデルを呼ぶ is the casual way to say it." },
      { ja: "ハルシネーション", en: "hallucination", note: "Sometimes 幻覚, but the loanword is standard." },
      { ja: "ガードレール", en: "guardrails", note: "Also a Bedrock feature name." },
      { ja: "下書{したが}き", en: "draft" },
      { ja: "未実装{みじっそう}", en: "not implemented", note: "まだ実装していません is the spoken form." },
      { ja: "非同期{ひどうき}", en: "asynchronous" },
    ],
    qa: [
      {
        q: { ja: "AIの機能は、もう使っていますか？", en: "Do you already use AI features?" },
        a: [
          { ja: "いいえ、まだ実装していません。", en: "No, not yet implemented." },
          { ja: "案としては、キャプションの下書きを考えています。", en: "The idea is caption drafts." },
          { ja: "AWSのアカウントが使えないので、試せていません。", en: "I couldn't try it because the AWS account isn't usable." },
        ],
        tip: "Answer 'no' cleanly first. An honest 未実装 followed by a sensible plan is far better than vagueness.",
      },
      {
        q: { ja: "入れるとしたら、どう組み込みますか？", en: "If you added it, how would you wire it in?" },
        a: [
          { ja: "レンダーと同じで、キューとワーカーを使います。", en: "The same way as rendering: a queue and a worker." },
          { ja: "モデルの応答は遅いので、Webでは待ちません。", en: "Model responses are slow, so the web request doesn't wait." },
          {
            ja: "物件の項目だけを渡して、事実を作らせないようにします。",
            en: "I'd pass only the listing fields so it can't invent facts.",
          },
          {
            ja: "結果は、今のInstagramのチェックにも通します。",
            en: "The result also goes through the existing Instagram checks.",
          },
        ],
      },
      {
        q: { ja: "生成AIのリスクは、どう考えますか？", en: "How do you think about the risks of generative AI?" },
        a: [
          { ja: "一番は、間違った物件情報を書くことです。", en: "The biggest is writing wrong facts about a property." },
          {
            ja: "あと、住宅の広告では、買う人を選ぶ表現は禁止です。",
            en: "Also, housing ads may not express a preference for who buys.",
          },
          { ja: "なので、必ず人が確認してから使います。", en: "So a person always reviews it before use." },
          { ja: "コストも、トークンの上限で管理します。", en: "Cost is controlled with token limits." },
        ],
      },
    ],
    videoSearch: ["Amazon Bedrock 入門", "Bedrock Claude 使い方", "生成AI ガードレール 解説"],
    docs: [
      { title: "Amazon Bedrock とは", url: "https://docs.aws.amazon.com/ja_jp/bedrock/latest/userguide/what-is-bedrock.html" },
      {
        title: "Converse API を使用して会話を行う",
        url: "https://docs.aws.amazon.com/ja_jp/bedrock/latest/userguide/conversation-inference.html",
      },
      { title: "Amazon Bedrock ガードレール", url: "https://docs.aws.amazon.com/ja_jp/bedrock/latest/userguide/guardrails.html" },
    ],
    related: ["worker", "sqs", "iam-secrets", "server-actions"],
  },

  // ── CloudWatch ──────────────────────────────────────────────────
  {
    id: "cloudwatch",
    group: "aws",
    name: "CloudWatch",
    ja: "監視{かんし}（ログとメトリクス）",
    say: "クラウドウォッチ",
    oneLiner: {
      ja: "ログ、メトリクス、アラームで、システムの状態を見ます。",
      en: "Logs, metrics and alarms show how the system is doing.",
    },
    explain: [
      { ja: "CloudWatchは、AWSの監視{かんし}サービスです。", en: "CloudWatch is AWS's monitoring service." },
      { ja: "ログ、メトリクス、アラームを1か所で見られます。", en: "Logs, metrics and alarms are in one place." },
      {
        ja: "今のワーカーは、ジョブIDを付けてログを標準出力{ひょうじゅんしゅつりょく}に出しています。",
        en: "Today the worker logs to stdout with the job ID on each line.",
      },
      { ja: "EKSでは、それをCloudWatch Logsに集める予定です。", en: "On EKS the plan is to collect that in CloudWatch Logs." },
      {
        ja: "一番見たいのは、キューで一番古いメッセージの経過時間です。",
        en: "The key metric is the age of the oldest message in the queue.",
      },
      { ja: "DLQにメッセージが入ったら、すぐアラームを出します。", en: "Any message in the DLQ raises an alarm right away." },
      { ja: "レンダー時間や失敗率も、メトリクスにしたいです。", en: "I'd also like render time and failure rate as metrics." },
    ],
    why: [
      {
        ja: "非同期処理は、止まっても画面ではすぐ気づけません。",
        en: "When async work stalls, you don't notice it on screen right away.",
      },
      {
        ja: "なので、キューの滞留{たいりゅう}とDLQを見るのが一番効きます。",
        en: "So watching queue backlog and the DLQ gives the most value.",
      },
      {
        ja: "ただ、ログやメトリクスを増やすと、コストも上がります。",
        en: "But more logs and metrics also means more cost.",
      },
    ],
    status: "designed",
    statusNote:
      "Not wired up: web and worker log plain text to stdout and Kubernetes probes check health, but there is no CloudWatch agent, metric or alarm in the repo; everything CloudWatch-specific here is the plan.",
    inRepo: [
      { path: "apps/worker/src/handler.ts", what: "Log lines prefixed with [jobId] for each decision and attempt." },
      { path: "apps/worker/src/index.ts", what: "/healthz returns 503 if the poll loop stops ticking." },
      { path: "infra/helm/reelwalk/templates/worker.yaml", what: "livenessProbe on /healthz; no readiness probe for a queue consumer." },
    ],
    terms: [
      { ja: "監視{かんし}", en: "monitoring", note: "モニタリング is also used." },
      { ja: "メトリクス", en: "metrics" },
      { ja: "アラーム", en: "alarm", note: "アラート is used more for the notification itself." },
      { ja: "閾値{しきいち}", en: "threshold", note: "Often misread as いきち; しきいち is standard." },
      { ja: "滞留{たいりゅう}", en: "backlog / messages piling up", note: "キューが滞留している = the queue is backing up." },
      { ja: "構造化{こうぞうか}ログ", en: "structured logging", note: "JSON logs; an improvement over today's plain text." },
      { ja: "可観測性{かかんそくせい}", en: "observability", note: "オブザーバビリティ is more common in speech." },
      { ja: "標準出力{ひょうじゅんしゅつりょく}", en: "standard output (stdout)" },
      { ja: "死活監視{しかつかんし}", en: "health / liveness monitoring" },
    ],
    qa: [
      {
        q: { ja: "本番では、何を監視{かんし}しますか？", en: "What would you monitor in production?" },
        a: [
          { ja: "まず、キューで一番古いメッセージの経過時間です。", en: "First, the age of the oldest message in the queue." },
          { ja: "これが伸びたら、ワーカーが足りないか止まっています。", en: "If it grows, workers are too few or stuck." },
          { ja: "次に、DLQのメッセージ数です。1件でもアラームです。", en: "Next, DLQ message count. Even one is an alarm." },
          { ja: "あとは、レンダーの失敗率と時間です。", en: "Then render failure rate and duration." },
        ],
        tip: "ApproximateAgeOfOldestMessage beats queue length: it shows user-facing delay directly.",
      },
      {
        q: { ja: "ワーカーが固まったら、どう気づきますか？", en: "How would you notice a stuck worker?" },
        a: [
          { ja: "ワーカーには、ヘルスチェックのエンドポイントがあります。", en: "The worker has a health check endpoint." },
          { ja: "ループが一定時間動かないと、503を返します。", en: "If the loop stops for a while, it returns 503." },
          { ja: "すると、Kubernetesが再起動します。", en: "Then Kubernetes restarts it." },
          { ja: "ジョブは、タイムアウト後に別のPodが引き継ぎます。", en: "The job is taken over by another pod after the timeout." },
        ],
        tip: "This part is real and runs on kind. Separate it clearly from the CloudWatch alarms, which are only planned.",
      },
      {
        q: { ja: "ログは、どう改善したいですか？", en: "How would you improve the logs?" },
        a: [
          { ja: "今はテキストなので、JSONの構造化{こうぞうか}ログにしたいです。", en: "They are plain text now; I'd move to structured JSON." },
          { ja: "ジョブID、世代、試行回数を項目にします。", en: "Job ID, generation and attempt become fields." },
          { ja: "そうすれば、CloudWatchで検索や集計ができます。", en: "Then CloudWatch can search and aggregate them." },
        ],
      },
    ],
    videoSearch: ["CloudWatch 入門 解説", "CloudWatch アラーム メトリクス 設定", "SQS 監視 CloudWatch"],
    docs: [
      {
        title: "Amazon CloudWatch とは",
        url: "https://docs.aws.amazon.com/ja_jp/AmazonCloudWatch/latest/monitoring/WhatIsCloudWatch.html",
      },
      {
        title: "Amazon SQS で利用可能な CloudWatch メトリクス",
        url: "https://docs.aws.amazon.com/ja_jp/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-available-cloudwatch-metrics.html",
      },
      {
        title: "Container Insights",
        url: "https://docs.aws.amazon.com/ja_jp/AmazonCloudWatch/latest/monitoring/ContainerInsights.html",
      },
    ],
    related: ["sqs", "retries-dlq", "worker", "eks", "kubernetes"],
  },

  // ── IAM & Secrets ───────────────────────────────────────────────
  {
    id: "iam-secrets",
    group: "aws",
    name: "IAM & Secrets",
    ja: "権限{けんげん}と秘密情報{ひみつじょうほう}",
    say: "アイアム、シークレット",
    oneLiner: {
      ja: "各ワークロードに、必要な権限だけをロールで渡します。",
      en: "Each workload gets only the permissions it needs, through a role.",
    },
    explain: [
      { ja: "AWSの権限{けんげん}は、IAMロールで渡します。", en: "AWS permissions are granted with IAM roles." },
      { ja: "アクセスキーを、コンテナに入れないのが基本です。", en: "The rule is: no access keys inside containers." },
      {
        ja: "EKSでは、Pod IdentityかIRSAでPodにロールを付けます。",
        en: "On EKS, Pod Identity or IRSA attaches a role to a pod.",
      },
      {
        ja: "Webはメッセージの送信、ワーカーは受信と削除だけです。",
        en: "The web app only sends messages; the worker only receives and deletes.",
      },
      { ja: "これが、最小権限{さいしょうけんげん}の原則です。", en: "That is the principle of least privilege." },
      { ja: "DBのパスワードは、KubernetesのSecretで渡します。", en: "The database password is passed in a Kubernetes Secret." },
      { ja: "本番では、そのSecretをチャートの外で管理します。", en: "In production that Secret is managed outside the chart." },
      {
        ja: "CIからAWSへは、OIDCで一時的{いちじてき}な認証情報{にんしょうじょうほう}を使います。",
        en: "From CI to AWS, OIDC provides temporary credentials.",
      },
    ],
    why: [
      { ja: "長く使えるキーは、漏{も}れたときの被害が大きいです。", en: "Long-lived keys do a lot of damage if they leak." },
      { ja: "ロールなら、認証情報が自動で入れ替わります。", en: "With roles, credentials rotate automatically." },
      {
        ja: "ただ、今のチャートはServiceAccountが1つです。",
        en: "However, the chart currently has a single ServiceAccount.",
      },
      {
        ja: "WebとワーカーでSAを分けるのが、次の改善点です。",
        en: "Splitting it between web and worker is the next improvement.",
      },
    ],
    status: "designed",
    statusNote:
      "Designed, not deployed: the chart has a ServiceAccount annotation hook for IRSA and an existingSecret switch, and CI has an OIDC role step that is skipped because AWS_ROLE_ARN is not set; locally the Secret holds throwaway MinIO and Postgres credentials, and web, worker and migrate share one ServiceAccount.",
    inRepo: [
      { path: "infra/helm/reelwalk/values.yaml", what: "serviceAccount annotations for IRSA and secret.create / existingSecret." },
      { path: "infra/helm/reelwalk/templates/config.yaml", what: "The ConfigMap, the optional Secret and the shared ServiceAccount." },
      { path: ".github/workflows/ci.yml", what: "id-token: write and configure-aws-credentials with a role, skipped until configured." },
      { path: "docs/adr/0004-kubernetes-and-helm.md", what: "ConfigMap vs Secret, and IRSA in production." },
    ],
    terms: [
      { ja: "最小権限{さいしょうけんげん}", en: "least privilege", note: "最小権限の原則 = principle of least privilege." },
      { ja: "IAMロール", en: "IAM role", note: "Say アイアムロール." },
      { ja: "ポリシー", en: "policy" },
      { ja: "認証情報{にんしょうじょうほう}", en: "credentials", note: "クレデンシャル is common in speech." },
      { ja: "シークレット", en: "secret", note: "秘密情報 in formal writing." },
      { ja: "サービスアカウント", en: "service account (Kubernetes)", note: "Often SA (エスエー)." },
      { ja: "一時的{いちじてき}な認証情報", en: "temporary credentials" },
      { ja: "漏洩{ろうえい}", en: "leak", note: "漏れる (もれる) is the everyday verb." },
      { ja: "ローテーション", en: "rotation" },
      { ja: "信頼{しんらい}ポリシー", en: "trust policy", note: "Who may assume the role." },
    ],
    qa: [
      {
        q: { ja: "ワーカーには、どんな権限を付けますか？", en: "What permissions would the worker get?" },
        a: [
          { ja: "レンダー用のキューの、受信と削除と延長だけです。", en: "Only receive, delete and change-visibility on the render queue." },
          { ja: "S3は、決まったバケットの読み書きだけにします。", en: "S3 is limited to reading and writing one bucket." },
          { ja: "リソースはARNで指定して、ワイルドカードは避けます。", en: "Resources are named by ARN; wildcards are avoided." },
          { ja: "Webには、送信と署名付きURLの発行だけを付けます。", en: "The web app gets only send and presigned-URL signing." },
        ],
        tip: "Concrete actions (sqs:ReceiveMessage, sqs:DeleteMessage, sqs:ChangeMessageVisibility) show you've thought it through. Add that it's a design, not deployed.",
      },
      {
        q: { ja: "シークレットは、どう管理していますか？", en: "How do you manage secrets?" },
        a: [
          { ja: "ローカルのkindでは、使い捨ての値をSecretに入れています。", en: "On local kind, throwaway values go into a Secret." },
          { ja: "本番では、チャートでは作らない設計です。", en: "In production the design is that the chart doesn't create it." },
          {
            ja: "Secrets Managerから、External Secretsで同期します。",
            en: "It would be synced from Secrets Manager with External Secrets.",
          },
          { ja: "Gitには、秘密情報を一切入れません。", en: "No secrets ever go into Git." },
        ],
      },
      {
        q: { ja: "IRSAとPod Identityの違いは何ですか？", en: "What's the difference between IRSA and Pod Identity?" },
        a: [
          { ja: "どちらも、PodにIAMロールを渡す仕組みです。", en: "Both give a pod an IAM role." },
          { ja: "IRSAは、OIDCプロバイダーとSAの注釈を使います。", en: "IRSA uses an OIDC provider and an annotation on the SA." },
          { ja: "Pod Identityは新しい方法で、設定が簡単です。", en: "Pod Identity is newer and simpler to set up." },
          { ja: "新しいクラスタなら、Pod Identityを選びます。", en: "For a new cluster I'd choose Pod Identity." },
        ],
        tip: "The chart's comment mentions IRSA; either works. Saying you'd pick Pod Identity for new clusters shows current knowledge.",
      },
    ],
    videoSearch: ["IAM ロール 最小権限 解説", "EKS Pod Identity IRSA 違い", "GitHub Actions OIDC AWS"],
    docs: [
      {
        title: "IAM でのセキュリティのベストプラクティス",
        url: "https://docs.aws.amazon.com/ja_jp/IAM/latest/UserGuide/best-practices.html",
      },
      { title: "EKS Pod Identity", url: "https://docs.aws.amazon.com/ja_jp/eks/latest/userguide/pod-identities.html" },
      {
        title: "サービスアカウントの IAM ロール (IRSA)",
        url: "https://docs.aws.amazon.com/ja_jp/eks/latest/userguide/iam-roles-for-service-accounts.html",
      },
    ],
    related: ["eks", "helm", "kubernetes", "github-actions", "terraform", "s3", "sqs"],
  },
];
