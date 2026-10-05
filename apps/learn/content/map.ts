import type { Line } from "../lib/types";

/** The system map: stations (services) placed on a 360 x 640 portrait canvas. */

export interface MapNode {
  id: string;
  x: number;
  y: number;
  /** Topic to open from this station. */
  topic: string;
  code: string;
  name: { aws: string; local: string };
  /** Short Japanese role, ruby markup allowed. */
  sub: string;
  /** Line colour of the ring. */
  color: string;
}

export const NODES: MapNode[] = [
  { id: "browser", x: 180, y: 42, topic: "server-components", code: "U", name: { aws: "Phone browser", local: "Phone browser" }, sub: "利用者{りようしゃ}の画面", color: "#18202b" },
  { id: "ingress", x: 180, y: 122, topic: "kubernetes", code: "P0", name: { aws: "ALB", local: "nginx" }, sub: "入口{いりぐち}", color: "#00A3D9" },
  { id: "web", x: 180, y: 200, topic: "server-actions", code: "A", name: { aws: "Next.js on EKS", local: "Next.js" }, sub: "画面と処理", color: "#0079C2" },
  { id: "postgres", x: 62, y: 300, topic: "postgresql", code: "D", name: { aws: "RDS Postgres", local: "Postgres" }, sub: "記録{きろく}", color: "#8F5BB5" },
  { id: "sqs", x: 196, y: 300, topic: "sqs", code: "Q", name: { aws: "SQS", local: "ElasticMQ" }, sub: "仕事の待{ま}ち行列{ぎょうれつ}", color: "#E2407F" },
  { id: "dlq", x: 310, y: 300, topic: "retries-dlq", code: "Q", name: { aws: "DLQ", local: "DLQ" }, sub: "失敗{しっぱい}した仕事", color: "#E2407F" },
  { id: "s3", x: 62, y: 418, topic: "s3", code: "D", name: { aws: "S3", local: "MinIO" }, sub: "ファイル保存{ほぞん}", color: "#8F5BB5" },
  { id: "worker", x: 236, y: 418, topic: "worker", code: "Q", name: { aws: "Worker on EKS", local: "Worker" }, sub: "Remotionで動画制作{どうがせいさく}", color: "#E2407F" },
  { id: "cloudfront", x: 62, y: 500, topic: "cloudfront", code: "W", name: { aws: "CloudFront", local: "MinIO URL" }, sub: "動画の配信{はいしん}", color: "#9A7B2F" },
  { id: "actions", x: 46, y: 606, topic: "github-actions", code: "C", name: { aws: "Actions", local: "Actions" }, sub: "テスト", color: "#00994C" },
  { id: "trivy", x: 113, y: 606, topic: "trivy", code: "T", name: { aws: "Trivy", local: "Trivy" }, sub: "脆弱性{ぜいじゃくせい}", color: "#EE8A00" },
  { id: "registry", x: 180, y: 606, topic: "docker", code: "P", name: { aws: "ECR", local: "kind load" }, sub: "イメージ", color: "#00A3D9" },
  { id: "argocd", x: 247, y: 606, topic: "argocd", code: "C", name: { aws: "Argo CD", local: "helm" }, sub: "同期{どうき}", color: "#00994C" },
  { id: "cluster", x: 314, y: 606, topic: "kubernetes", code: "P", name: { aws: "EKS", local: "kind" }, sub: "クラスター", color: "#00A3D9" },
];

/** Grey track between stations. Optional bend points make railway-style corners. */
export const EDGES: { a: string; b: string; via?: [number, number][] }[] = [
  { a: "browser", b: "ingress" },
  { a: "ingress", b: "web" },
  { a: "web", b: "postgres", via: [[62, 250]] },
  { a: "web", b: "sqs", via: [[196, 250]] },
  { a: "sqs", b: "dlq" },
  { a: "sqs", b: "worker", via: [[196, 370], [236, 370]] },
  { a: "worker", b: "postgres", via: [[130, 418], [130, 340], [62, 340]] },
  { a: "worker", b: "s3" },
  { a: "dlq", b: "worker", via: [[310, 418]] },
  { a: "browser", b: "s3", via: [[18, 42], [18, 418]] },
  { a: "s3", b: "cloudfront" },
  { a: "cloudfront", b: "browser", via: [[18, 500], [18, 42]] },
  { a: "actions", b: "trivy" },
  { a: "trivy", b: "registry" },
  { a: "registry", b: "argocd" },
  { a: "argocd", b: "cluster" },
  { a: "cluster", b: "worker", via: [[342, 606], [342, 470], [236, 470]] },
];

export interface Stop {
  at: string;
  line: Line;
  more?: Line[];
}

export interface Route {
  id: string;
  color: string;
  title: Line;
  summary: string;
  stops: Stop[];
}

export const ROUTES: Route[] = [
  {
    id: "upload",
    color: "#0079C2",
    title: { ja: "素材{そざい}のアップロード", en: "Uploading media" },
    summary: "How a 360 photo or clip gets from the phone into storage without passing through the web server.",
    stops: [
      {
        at: "browser",
        line: { ja: "利用者{りようしゃ}が、スマホで動画や360度の写真を選{えら}びます。", en: "The user picks videos or 360° photos on their phone." },
      },
      {
        at: "web",
        line: { ja: "Server Actionが、署名付{しょめいつ}きURLを発行{はっこう}します。", en: "A Server Action issues a presigned URL." },
        more: [{ ja: "その前に、ファイルの種類{しゅるい}とサイズを検証{けんしょう}します。", en: "Before that, it validates the file type and size." }],
      },
      {
        at: "s3",
        line: { ja: "ブラウザーから、S3へ直接{ちょくせつ}アップロードします。", en: "The browser uploads straight to S3." },
        more: [
          { ja: "大きいファイルがNext.jsを通{とお}らないので、サーバーが軽{かる}いままです。", en: "Large files never pass through Next.js, so the server stays light." },
          { ja: "ローカルでは、MinIOがS3の代{か}わりです。", en: "Locally, MinIO stands in for S3." },
        ],
      },
      {
        at: "web",
        line: { ja: "アップロードが終{お}わったら、サーバーでファイルを確認{かくにん}します。", en: "When the upload finishes, the server checks the file." },
      },
      {
        at: "postgres",
        line: { ja: "Prismaで、素材のレコードを保存{ほぞん}します。", en: "Prisma saves a record for the media asset." },
        more: [{ ja: "ファイル本体{ほんたい}はS3、情報{じょうほう}はデータベースに分{わ}けます。", en: "The file itself lives in S3; the information about it lives in the database." }],
      },
    ],
  },
  {
    id: "export",
    color: "#E2407F",
    title: { ja: "書{か}き出{だ}しとレンダリング", en: "Export and render" },
    summary: "One tap on Export, followed through the queue, the worker and back to the phone.",
    stops: [
      {
        at: "browser",
        line: { ja: "編集画面{へんしゅうがめん}で、書き出しボタンを押{お}します。", en: "The user taps Export in the editor." },
      },
      {
        at: "web",
        line: { ja: "Server Actionが、入力{にゅうりょく}とワークスペースを確認します。", en: "A Server Action checks the input and the workspace." },
      },
      {
        at: "postgres",
        line: { ja: "レンダリングのジョブを、待機中{たいきちゅう}として保存します。", en: "It saves a render job in the QUEUED state." },
      },
      {
        at: "sqs",
        line: { ja: "SQSには、ジョブIDだけの小さいメッセージを送{おく}ります。", en: "It sends SQS a small message with just the job ID." },
        more: [
          { ja: "詳{くわ}しい情報は、すべてデータベースにあります。", en: "All the details stay in the database." },
          { ja: "だから、メッセージとデータが食{く}い違{ちが}うことはありません。", en: "So the message can never disagree with the data." },
        ],
      },
      {
        at: "worker",
        line: { ja: "ワーカーが、ロングポーリングでメッセージを受{う}け取{と}ります。", en: "A worker receives the message by long polling." },
      },
      {
        at: "postgres",
        line: { ja: "条件付{じょうけんつ}きの更新{こうしん}で、ジョブを実行中{じっこうちゅう}にします。", en: "A conditional update moves the job to RUNNING." },
        more: [
          { ja: "状態{じょうたい}と世代{せだい}が合{あ}うときだけ、更新が成功{せいこう}します。", en: "The update only succeeds when the status and generation match." },
          { ja: "これで、二{ふた}つのワーカーが同{おな}じジョブを取{と}りません。", en: "So two workers never take the same job." },
        ],
      },
      {
        at: "s3",
        line: { ja: "S3から、素材をダウンロードします。", en: "It downloads the media from S3." },
      },
      {
        at: "worker",
        line: { ja: "Remotionが、プレビューと同じコンポーネントでMP4を作ります。", en: "Remotion renders the MP4 with the same component as the preview." },
        more: [{ ja: "定期的{ていきてき}に、進捗{しんちょく}とハートビートを書{か}き込{こ}みます。", en: "It regularly writes progress and a heartbeat." }],
      },
      {
        at: "s3",
        line: { ja: "完成{かんせい}したMP4を、S3にアップロードします。", en: "It uploads the finished MP4 to S3." },
      },
      {
        at: "postgres",
        line: { ja: "ジョブを成功{せいこう}にして、出力{しゅつりょく}を記録{きろく}します。", en: "It marks the job SUCCEEDED and records the output." },
      },
      {
        at: "sqs",
        line: { ja: "最後{さいご}に、SQSのメッセージを削除{さくじょ}します。", en: "Only then does it delete the SQS message." },
        more: [{ ja: "保存してから削除するので、途中{とちゅう}で落{お}ちても仕事{しごと}は消{き}えません。", en: "Saving before deleting means a crash midway never loses the work." }],
      },
      {
        at: "web",
        line: { ja: "画面は、データベースから進捗を読{よ}んで表示{ひょうじ}します。", en: "The screen reads progress from the database and shows it." },
      },
      {
        at: "cloudfront",
        line: { ja: "AWSでは、CloudFrontから動画を配信{はいしん}する設計{せっけい}です。", en: "On AWS, the design delivers the video through CloudFront." },
      },
      {
        at: "browser",
        line: { ja: "利用者は、動画を再生{さいせい}して保存{ほぞん}や共有{きょうゆう}ができます。", en: "The user can play, save and share the video." },
      },
    ],
  },
  {
    id: "failure",
    color: "#EE8A00",
    title: { ja: "ワーカーが落{お}ちたら", en: "When a worker crashes" },
    summary: "At-least-once delivery, heartbeats and the dead-letter queue, step by step.",
    stops: [
      {
        at: "worker",
        line: { ja: "レンダリングの途中{とちゅう}で、ワーカーのポッドが落ちました。", en: "The worker pod crashes in the middle of a render." },
      },
      {
        at: "sqs",
        line: { ja: "メッセージは削除されていないので、SQSに残{のこ}っています。", en: "The message was never deleted, so it is still in SQS." },
        more: [
          { ja: "ワーカーが止{と}まると、可視性{かしせい}タイムアウトの延長{えんちょう}も止まります。", en: "Once the worker stops, it stops extending the visibility timeout." },
          { ja: "タイムアウトが切{き}れると、メッセージがまた見{み}えるようになります。", en: "When the timeout runs out, the message becomes visible again." },
        ],
      },
      {
        at: "worker",
        line: { ja: "別{べつ}のワーカーが、同じメッセージを受け取ります。", en: "Another worker receives the same message." },
      },
      {
        at: "postgres",
        line: { ja: "まず、データベースでジョブの状態を確認します。", en: "First it checks the job's state in the database." },
        more: [
          { ja: "世代が古{ふる}いメッセージや、完了済{かんりょうず}みのジョブは捨{す}てます。", en: "Messages from an old generation, or for a finished job, are thrown away." },
          { ja: "ハートビートが新{あたら}しければ、他のワーカーに任{まか}せます。", en: "If the heartbeat is fresh, it leaves the job to the other worker." },
          { ja: "ハートビートが古ければ、止まったと判断{はんだん}して引{ひ}き継{つ}ぎます。", en: "If the heartbeat is stale, it decides the worker died and takes over." },
        ],
      },
      {
        at: "sqs",
        line: { ja: "エラーが出{で}たら、指数{しすう}バックオフで再試行{さいしこう}します。", en: "If a render throws, it retries with exponential backoff." },
        more: [{ ja: "可視性タイムアウトを延{の}ばして、待ち時間を作ります。", en: "It creates the wait by extending the visibility timeout." }],
      },
      {
        at: "dlq",
        line: { ja: "三回{さんかい}受信{じゅしん}しても終わらなければ、デッドレターキューに移{うつ}ります。", en: "After three receives without success, the message moves to the dead-letter queue." },
      },
      {
        at: "worker",
        line: { ja: "ワーカーはDLQも読{よ}んで、残ったジョブを失敗{しっぱい}にします。", en: "The worker also reads the DLQ and fails any job left behind." },
        more: [{ ja: "毎回{まいかい}ポッドが落ちた場合、誰{だれ}も失敗を書{か}いていないからです。", en: "If every attempt crashed its pod, nobody wrote FAILED yet." }],
      },
      {
        at: "postgres",
        line: { ja: "ジョブはFAILEDになり、エラーの内容{ないよう}が残ります。", en: "The job becomes FAILED and the error is kept." },
      },
      {
        at: "browser",
        line: { ja: "利用者は、画面から手動{しゅどう}でリトライできます。", en: "The user can retry manually from the screen." },
        more: [{ ja: "リトライで世代を上{あ}げるので、古いメッセージは無視{むし}されます。", en: "A retry bumps the generation, so old messages get ignored." }],
      },
    ],
  },
  {
    id: "deploy",
    color: "#00994C",
    title: { ja: "コードから本番{ほんばん}まで", en: "From code to production" },
    summary: "The CI pipeline that runs today, and the deploy steps that are designed but waiting on AWS.",
    stops: [
      {
        at: "actions",
        line: { ja: "プッシュすると、GitHub Actionsが動{うご}きます。", en: "A push starts GitHub Actions." },
        more: [{ ja: "Lint、型{かた}チェック、ユニットテスト、Helmのlintを実行{じっこう}します。", en: "It runs lint, type checks, unit tests and a Helm lint." }],
      },
      {
        at: "trivy",
        line: { ja: "Trivyで、依存関係{いぞんかんけい}と設定{せってい}とイメージをスキャンします。", en: "Trivy scans the dependencies, the config and the images." },
        more: [{ ja: "重大{じゅうだい}な脆弱性{ぜいじゃくせい}があれば、パイプラインを止めます。", en: "A serious vulnerability stops the pipeline." }],
      },
      {
        at: "registry",
        line: { ja: "Dockerイメージをビルドして、ECRにプッシュします。", en: "It builds the Docker images and pushes them to ECR." },
        more: [{ ja: "ECRへのプッシュは、AWSアカウントの確認待{かくにんま}ちで、まだ動かしていません。", en: "The ECR push hasn't run yet: the AWS account is waiting on verification." }],
      },
      {
        at: "argocd",
        line: { ja: "Argo CDが、GitのHelmチャートとクラスターを同期{どうき}します。", en: "Argo CD syncs the cluster with the Helm chart in Git." },
        more: [{ ja: "マニフェストは書きましたが、まだインストールはしていません。", en: "The manifests are written but not installed yet." }],
      },
      {
        at: "cluster",
        line: { ja: "Kubernetesが、ローリングアップデートでポッドを入{い}れ替{か}えます。", en: "Kubernetes swaps the pods with a rolling update." },
        more: [
          { ja: "readinessプローブが通{とお}ってから、トラフィックを流{なが}します。", en: "Traffic only goes to a pod once its readiness probe passes." },
          { ja: "ローカルでは、kindのクラスターでこの流{なが}れを確認しました。", en: "Locally, I checked this flow on a kind cluster." },
        ],
      },
      {
        at: "worker",
        line: { ja: "Webとワーカーは、別々{べつべつ}にスケールできます。", en: "Web and worker scale separately." },
      },
    ],
  },
];
