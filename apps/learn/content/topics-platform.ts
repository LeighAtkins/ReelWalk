import type { Topic } from "../lib/types";

// Product names with the reading Japanese engineers use, so furigana and
// text-to-speech say them the way an interviewer would.
const DOCKER = "[Docker]{ドッカー}";
const K8S = "[Kubernetes]{クバネティス}";
const HELM = "[Helm]{ヘルム}";
const KIND = "[kind]{カインド}";
const EKS = "[EKS]{イーケーエス}";
const GHA = "[GitHub Actions]{ギットハブアクションズ}";
const ARGO = "[Argo CD]{アルゴシーディー}";
const TF = "[Terraform]{テラフォーム}";
const TRIVY = "[Trivy]{トリビー}";
const VITEST = "[Vitest]{ヴィテスト}";
const PW = "[Playwright]{プレイライト}";

export const platformTopics: Topic[] = [
  // ───────────────────────────────────────────────────────────── docker
  {
    id: "docker",
    group: "platform",
    name: "Docker",
    ja: "コンテナイメージ",
    say: "ドッカー",
    oneLiner: {
      ja: `アプリを${DOCKER}イメージにして、どこでも同じ環境で動かします。`,
      en: "We package each app as a Docker image so it runs the same way everywhere.",
    },
    explain: [
      {
        ja: "デプロイする単位{たんい}ごとに、イメージを一つずつ作っています。",
        en: "We build one image per deployable unit.",
      },
      {
        ja: "webはNext.jsで、workerは動画を書{か}き出{だ}すNodeのプロセスです。",
        en: "web is the Next.js app; worker is the Node process that renders videos.",
      },
      {
        ja: "どちらもマルチステージビルドで、ビルド用と実行用を分けています。",
        en: "Both use multi-stage builds that separate the build stage from the runtime stage.",
      },
      {
        ja: "webはNext.jsのstandalone出力で、必要なファイルだけをコピーします。",
        en: "web uses Next.js standalone output and copies only the files the server needs.",
      },
      {
        ja: "workerにはChromeとffmpegが入っていて、MP4を書き出します。",
        en: "The worker image contains Chrome and ffmpeg, and renders MP4s.",
      },
      {
        ja: "Chromeはビルド時にダウンロードするので、ポッドがすぐ動けます。",
        en: "Chrome is downloaded at build time, so a new pod can start working right away.",
      },
      {
        ja: "実行用イメージからは、npmなどのパッケージマネージャーを消{け}しています。",
        en: "The package managers such as npm are removed from the runtime images.",
      },
      {
        ja: "最後にUSER nodeで、root以外のユーザーとして動かします。",
        en: "Finally, USER node makes them run as a non-root user.",
      },
    ],
    why: [
      {
        ja: "デプロイ単位で分けると、それぞれ必要なものだけを入れられます。",
        en: "Splitting by deployable means each image holds only what it needs.",
      },
      {
        ja: "workerはChromeを含むので重{おも}いですが、webは軽{かる}いままです。",
        en: "The worker is heavy because it contains Chrome, but web stays light.",
      },
      {
        ja: "トレードオフは、Dockerfileが二つになり、管理が増えることです。",
        en: "The trade-off is two Dockerfiles to maintain.",
      },
    ],
    status: "built",
    statusNote:
      "Real: the web and worker images build in CI on every push and run in Docker Compose and on the local kind cluster; they have never been pushed to a registry.",
    inRepo: [
      { path: "apps/web/Dockerfile", what: "Three stages: deps, builder, and a runner that copies only the standalone output and runs as node." },
      { path: "apps/worker/Dockerfile", what: "Chrome libraries and ffmpeg in the base, a --prod install, Chrome downloaded at build time, tsx started directly so SIGTERM arrives." },
      { path: "apps/web/next.config.ts", what: "output: \"standalone\" with the monorepo root as the tracing root." },
      { path: ".dockerignore", what: "Keeps node_modules, build output and local data out of the build context." },
    ],
    terms: [
      { ja: "コンテナ", en: "container", note: "Always the katakana word; nobody says 容器 in this sense." },
      { ja: "イメージ", en: "image", note: "コンテナイメージ in full. ビルドする / プッシュする / プルする are the verbs." },
      { ja: "マルチステージビルド", en: "multi-stage build" },
      { ja: "ベースイメージ", en: "base image", note: "e.g. node:22-alpine for web, node:22-bookworm-slim for worker." },
      { ja: "レイヤーキャッシュ", en: "layer cache", note: "Copying package.json files before the source keeps the install layer cached." },
      { ja: "非{ひ}rootユーザー", en: "non-root user", note: "Also said as ルート権限{けんげん}なしで動かす." },
      { ja: "依存関係{いぞんかんけい}", en: "dependencies", note: "Often shortened to 依存{いぞん}. Engineers also say ディペンデンシー." },
      { ja: "攻撃対象領域{こうげきたいしょうりょういき}", en: "attack surface", note: "アタックサーフェス is just as common in speech." },
      { ja: "軽量化{けいりょうか}", en: "making something smaller / lighter", note: "イメージの軽量化 = reducing image size." },
      { ja: "書{か}き出{だ}し", en: "export / render (of a video)", note: "レンダリング is also fine." },
    ],
    qa: [
      {
        q: {
          ja: "イメージのサイズや安全性で、工夫したことはありますか？",
          en: "Did you do anything to keep the images small and safe?",
        },
        a: [
          { ja: "マルチステージで、ビルド用の道具を最終{さいしゅう}イメージに残しません。", en: "With multi-stage builds, no build tooling is left in the final image." },
          { ja: "workerは本番用{ほんばんよう}の依存{いぞん}だけをインストールしています。", en: "The worker installs production dependencies only." },
          { ja: "使わないnpmやcorepackも、実行用イメージから消しました。", en: "I also removed npm and corepack, which are unused, from the runtime image." },
          { ja: `それで、${TRIVY}のHIGHとCRITICALの指摘{してき}がなくなりました。`, en: "That cleared Trivy's HIGH and CRITICAL findings." },
          { ja: "最後に、rootではなくnodeユーザーで実行しています。", en: "And it runs as the node user, not root." },
        ],
        tip: "Give a concrete before/after: Trivy flagged the bundled npm, the pnpm store and old esbuild builds; removing them (commit c317ca1) cleared the image scan.",
      },
      {
        q: {
          ja: "なぜwebとworkerで、イメージを分けたのですか？",
          en: "Why separate images for web and worker?",
        },
        a: [
          { ja: "必要なものが、全然{ぜんぜん}違うからです。", en: "Because they need completely different things." },
          { ja: "workerはChromeとffmpegが必要で、イメージが重くなります。", en: "The worker needs Chrome and ffmpeg, which makes the image heavy." },
          { ja: "webにそれを入れると、デプロイも起動も遅{おそ}くなります。", en: "Putting that into web would slow down its deploys and startup." },
          { ja: "分けておけば、別々{べつべつ}にスケールもできます。", en: "Kept apart, they can also scale independently." },
        ],
        tip: "Link it to the architecture: rendering runs in separate workers (ADR 0003), so the image split follows the process split.",
      },
      {
        q: {
          ja: "コンテナを止めるとき、気をつけたことはありますか？",
          en: "Anything you were careful about when containers stop?",
        },
        a: [
          { ja: "workerは、tsxを直接{ちょくせつ}起動しています。", en: "The worker starts tsx directly." },
          { ja: "パッケージマネージャー経由{けいゆ}だと、SIGTERMが届{とど}かないからです。", en: "Through a package manager, SIGTERM would not reach it." },
          { ja: "SIGTERMを受けると、今の書き出しを終えてから止まります。", en: "On SIGTERM it finishes the current render, then stops." },
          { ja: `${K8S}の猶予{ゆうよ}時間は、300秒にしています。`, en: "The Kubernetes grace period is set to 300 seconds." },
        ],
        tip: "Graceful shutdown is a classic follow-up. Mention terminationGracePeriodSeconds: 300 in the chart values.",
      },
    ],
    videoSearch: ["Docker マルチステージビルド 解説", "Docker 入門 コンテナ イメージ", "Next.js standalone Docker"],
    docs: [
      { title: "Docker: Multi-stage builds", url: "https://docs.docker.com/build/building/multi-stage/" },
      { title: "Next.js: output (standalone)", url: "https://nextjs.org/docs/app/api-reference/config/next-config-js/output" },
    ],
    related: ["kubernetes", "trivy", "nextjs", "worker", "remotion", "github-actions"],
  },

  // ───────────────────────────────────────────────────────────── kubernetes
  {
    id: "kubernetes",
    group: "platform",
    name: "Kubernetes",
    ja: "コンテナオーケストレーション",
    say: "クバネティス",
    oneLiner: {
      ja: `コンテナを宣言的{せんげんてき}に管理し、落{お}ちたら自動で戻{もど}します。`,
      en: "It manages containers declaratively and brings them back automatically when they fail.",
    },
    explain: [
      { ja: `${K8S}は、コンテナをまとめて動かす基盤{きばん}です。`, en: "Kubernetes is the platform that runs containers together." },
      { ja: "一番小さい単位{たんい}は、ポッドです。", en: "The smallest unit is the Pod." },
      { ja: "webとworkerは、それぞれ別のデプロイメントです。", en: "web and worker are separate Deployments." },
      { ja: "webはレプリカ2つで、サービス経由{けいゆ}でアクセスします。", en: "web has two replicas and is reached through a Service." },
      { ja: "workerはキューから仕事を取るので、サービスはありません。", en: "The worker pulls work from the queue, so it has no Service." },
      { ja: "webには、/api/readyと/api/healthの二つのプローブがあります。", en: "web has two probes: /api/ready and /api/health." },
      { ja: "すべてのコンテナに、リクエストとリミットを設定しています。", en: "Every container has resource requests and limits." },
      { ja: "DBのマイグレーションは、リリースごとにJobで実行します。", en: "Database migrations run as a Job on each release." },
    ],
    why: [
      { ja: "ReelWalkには、性質{せいしつ}の違うワークロードが三つあります。", en: "ReelWalk has three workloads with different needs." },
      { ja: "止めずに更新するweb、数を増やすworker、一回だけのマイグレーションです。", en: "web that updates without downtime, workers that scale out, and a run-once migration." },
      { ja: "この規模{きぼ}なら、運用が楽なECSも十分{じゅうぶん}な選択肢{せんたくし}です。", en: "At this size ECS, which is easier to run, would also be a reasonable choice." },
      { ja: "それでも、同じマニフェストがローカルとEKSで動くので選びました。", en: "I still chose Kubernetes because the same manifests run locally and on EKS." },
    ],
    status: "built",
    statusNote:
      "The Deployments, Service, probes, resources and migration Job are real and run on a local kind cluster; they have never run on a cloud cluster.",
    inRepo: [
      { path: "infra/helm/reelwalk/templates/web.yaml", what: "web Deployment with maxUnavailable: 0, readiness on /api/ready, liveness on /api/health, plus the Service." },
      { path: "infra/helm/reelwalk/templates/worker.yaml", what: "worker Deployment: no Service, liveness on /healthz, /dev/shm in memory for Chrome, 300 s grace period." },
      { path: "infra/helm/reelwalk/templates/migrate-job.yaml", what: "The migration Job, named with a hash because a Job's pod template is immutable." },
      { path: "docs/adr/0004-kubernetes-and-helm.md", what: "Why Kubernetes, why the probe split, and the ECS alternative." },
    ],
    terms: [
      { ja: "ポッド", en: "Pod", note: "Always katakana." },
      { ja: "デプロイメント", en: "Deployment (the resource)", note: "デプロイ is the act of deploying; デプロイメント usually means the Kubernetes object." },
      { ja: "サービス", en: "Service", note: "Context makes it clear; say Kubernetesのサービス if ambiguous." },
      { ja: "レプリカ", en: "replica" },
      { ja: "レディネスプローブ／ライブネスプローブ", en: "readiness probe / liveness probe", note: "Often just readiness / liveness in Latin letters." },
      { ja: "死活監視{しかつかんし}", en: "health monitoring (alive or dead)", note: "The classic kanji term for what liveness does." },
      { ja: "リクエストとリミット", en: "resource requests and limits", note: "Kanji alternative: リソースの要求{ようきゅう}と上限{じょうげん}." },
      { ja: "ローリングアップデート", en: "rolling update" },
      { ja: "宣言的{せんげんてき}", en: "declarative", note: "宣言的に管理する = describe the desired state and let the system converge." },
      { ja: "猶予期間{ゆうよきかん}", en: "grace period", note: "For terminationGracePeriodSeconds; engineers also say グレースピリオド." },
    ],
    qa: [
      {
        q: { ja: "readinessとlivenessの違いは何ですか？", en: "What is the difference between readiness and liveness?" },
        a: [
          { ja: "livenessは、プロセスが生{い}きているかを見ます。", en: "Liveness checks whether the process is alive." },
          { ja: "失敗すると、コンテナが再起動されます。", en: "If it fails, the container is restarted." },
          { ja: "readinessは、トラフィックを受けられるかを見ます。", en: "Readiness checks whether it can take traffic." },
          { ja: "失敗しても、サービスから外{はず}されるだけです。", en: "If it fails, the pod is only taken out of the Service." },
          { ja: "ReelWalkでは、readinessだけがDBを確認します。", en: "In ReelWalk only readiness checks the database." },
          { ja: "DBが落ちても、再起動のループにならないためです。", en: "That way a database outage does not cause a restart loop." },
        ],
        tip: "The point they want: a dependency outage should remove pods from rotation, not restart them. /api/ready also returns 503 until the seed has run.",
      },
      {
        q: { ja: `なぜ${K8S}を選んだのですか？`, en: "Why did you choose Kubernetes?" },
        a: [
          { ja: "性質の違うワークロードが、三つあったからです。", en: "Because there were three workloads with different needs." },
          { ja: "ローリングアップデート、スケール、Jobが全部そろっています。", en: "Rolling updates, scaling and Jobs are all built in." },
          { ja: "ECSのほうが運用は楽で、それも検討{けんとう}しました。", en: "ECS is easier to operate, and I considered it." },
          { ja: `ただ、同じチャートが${KIND}とEKSの両方で動きます。`, en: "But the same chart runs on both kind and EKS." },
          { ja: "今は、ローカルのkindで検証{けんしょう}しています。", en: "For now I have verified it on a local kind cluster." },
        ],
        tip: "Naming the alternative you rejected (ECS/Fargate) and why shows judgment. Say kind, not production.",
      },
      {
        q: { ja: "ダウンタイムなしで、どうデプロイしますか？", en: "How do you deploy without downtime?" },
        a: [
          { ja: "ローリングアップデートで、maxUnavailableを0にしています。", en: "A rolling update with maxUnavailable set to 0." },
          { ja: "新しいポッドがreadyになってから、古いポッドを止めます。", en: "Old pods stop only after new ones are ready." },
          { ja: "マイグレーションは、Jobで実行します。", en: "Migrations run as a Job." },
          { ja: "readinessが、マイグレーションの完了{かんりょう}を待ちます。", en: "Readiness waits for the migration to finish." },
          { ja: "workerは、今の書き出しを終えてから止まります。", en: "Workers finish their current render before stopping." },
        ],
        tip: "Mention that migrations must stay backward compatible, because old and new pods run side by side during the rollout.",
      },
      {
        q: { ja: "requestsとlimitsは、どう決めましたか？", en: "How did you set requests and limits?" },
        a: [
          { ja: "requestsは、スケジューリングの目安{めやす}です。", en: "Requests are what the scheduler uses to place pods." },
          { ja: "limitsは、メモリだけに付けています。", en: "Limits are set on memory only." },
          { ja: "CPUは、空{あ}いている時に使えるようにしています。", en: "CPU is left unlimited so pods can use spare capacity." },
          { ja: "workerはChromeを使うので、メモリを多めにしました。", en: "The worker gets more memory because it runs Chrome." },
          { ja: "ただ、値{あたい}は本番の計測{けいそく}ではなく、見積{みつ}もりです。", en: "But the values are estimates, not production measurements." },
        ],
        tip: "Memory over the limit means OOMKilled; CPU over a limit means throttling. Be clear the numbers are not from production load.",
      },
    ],
    videoSearch: ["Kubernetes 入門 解説", "Kubernetes readiness liveness プローブ", "CKAD 対策 勉強"],
    docs: [
      { title: "Kubernetes: Deployment (日本語)", url: "https://kubernetes.io/ja/docs/concepts/workloads/controllers/deployment/" },
      { title: "Liveness、Readiness、Startup Probeを使用する", url: "https://kubernetes.io/ja/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/" },
      { title: "コンテナのリソース管理", url: "https://kubernetes.io/ja/docs/concepts/configuration/manage-resources-containers/" },
    ],
    related: ["helm", "kind", "eks", "docker", "worker", "prisma"],
  },

  // ───────────────────────────────────────────────────────────── helm
  {
    id: "helm",
    group: "platform",
    name: "Helm",
    ja: `${K8S}のパッケージ管理`,
    say: "ヘルム",
    oneLiner: {
      ja: "マニフェストを、テンプレートと値{あたい}でまとめるツールです。",
      en: "It packages Kubernetes manifests as templates plus values.",
    },
    explain: [
      { ja: `${HELM}は、${K8S}のパッケージマネージャーです。`, en: "Helm is the package manager for Kubernetes." },
      { ja: "パッケージのことを、チャートと呼{よ}びます。", en: "A package is called a chart." },
      { ja: "ReelWalkのチャートは、infra/helm/reelwalkにあります。", en: "ReelWalk's chart is in infra/helm/reelwalk." },
      { ja: "テンプレートは、web、worker、マイグレーションのJobです。", en: "The templates are web, worker and the migration Job." },
      { ja: "環境ごとの違いは、valuesファイルに書きます。", en: "Per-environment differences go into values files." },
      { ja: "values.yamlは、AWS向けのデフォルトです。", en: "values.yaml holds the defaults for AWS." },
      { ja: "values-kind.yamlは、ローカルのkind用の上書{うわが}きです。", en: "values-kind.yaml overrides them for the local kind cluster." },
      { ja: "CIでは、両方の組{く}み合{あ}わせでhelm lintをかけます。", en: "CI runs helm lint against both combinations." },
    ],
    why: [
      { ja: "環境の差が、ファイル一つにはっきり出ます。", en: "The differences between environments show up clearly in one file." },
      { ja: "環境が一つなら、素{す}のマニフェストやKustomizeでも十分です。", en: "With one environment, plain manifests or Kustomize would be enough." },
      { ja: "デメリットは、テンプレートの文法{ぶんぽう}が読みにくいことです。", en: "The downside is that template syntax is hard to read." },
    ],
    status: "built",
    statusNote:
      "Real: the chart is linted in CI and installed on the local kind cluster with values-kind.yaml; values.yaml (the AWS defaults) has never been installed anywhere.",
    inRepo: [
      { path: "infra/helm/reelwalk/values.yaml", what: "Defaults for a real cluster: AWS endpoints empty, secret.create false, IRSA annotation slot." },
      { path: "infra/helm/reelwalk/values-kind.yaml", what: "kind overrides: NodePort 30080, MinIO and ElasticMQ endpoints, throwaway credentials." },
      { path: "infra/helm/reelwalk/templates/_helpers.tpl", what: "Shared labels, the config checksum, and the non-root, read-only security contexts." },
      { path: "infra/helm/reelwalk/templates/migrate-job.yaml", what: "Job name hashed from the image tag and chart version." },
    ],
    terms: [
      { ja: "チャート", en: "chart" },
      { ja: "テンプレート", en: "template" },
      { ja: "values（バリューズ）", en: "values file", note: "Usually just said in English: バリューズファイル." },
      { ja: "リリース", en: "release (an installed chart)" },
      { ja: "上書{うわが}き", en: "override", note: "オーバーライド is also common." },
      { ja: "雛形{ひながた}", en: "template / boilerplate", note: "The kanji alternative to テンプレート; you will hear both." },
      { ja: "チェックサム", en: "checksum", note: "checksum/config annotation rolls pods when the ConfigMap or Secret changes." },
      { ja: "ConfigMapとSecret", en: "ConfigMap and Secret", note: "Said コンフィグマップ / シークレット." },
      { ja: "不変{ふへん}", en: "immutable", note: "イミュータブル is equally common." },
    ],
    qa: [
      {
        q: { ja: "values.yamlとvalues-kind.yamlの違いは何ですか？", en: "What is the difference between values.yaml and values-kind.yaml?" },
        a: [
          { ja: "values.yamlは、本物のS3とSQSが前提{ぜんてい}です。", en: "values.yaml assumes real S3 and SQS." },
          { ja: "values-kind.yamlは、接続先{せつぞくさき}をMinIOとElasticMQに変えます。", en: "values-kind.yaml points the endpoints at MinIO and ElasticMQ." },
          { ja: "サービスはNodePortにして、localhost:8081で開けます。", en: "The Service becomes a NodePort, reachable on localhost:8081." },
          { ja: "ローカル用の、使{つか}い捨{す}ての認証情報{にんしょうじょうほう}もここです。", en: "The throwaway local credentials are there too." },
          { ja: "アプリのコードには、ローカル専用{せんよう}の分岐{ぶんき}がありません。", en: "The application code has no local-only branches." },
        ],
        tip: "Key message: the app always speaks the S3/SQS APIs; only configuration differs between environments.",
      },
      {
        q: { ja: "設定を変えたとき、ポッドはどう更新されますか？", en: "How are pods updated when configuration changes?" },
        a: [
          { ja: "ConfigMapとSecretのチェックサムを、アノテーションに入れています。", en: "A checksum of the ConfigMap and Secret is put into an annotation." },
          { ja: "設定が変わると、チェックサムも変わります。", en: "When the settings change, so does the checksum." },
          { ja: "するとポッドのテンプレートが変わり、ローリングアップデートが始まります。", en: "That changes the pod template, which triggers a rolling update." },
        ],
        tip: "envFrom values are read only at container start, so without this trick a config change would not reach running pods.",
      },
      {
        q: { ja: "マイグレーションJobの名前に、ハッシュを付けたのはなぜですか？", en: "Why does the migration Job name include a hash?" },
        a: [
          { ja: "Jobのポッドテンプレートは、後から変更できないからです。", en: "Because a Job's pod template cannot be changed afterwards." },
          { ja: "同じ名前のままだと、upgradeが失敗します。", en: "With the same name, the upgrade would fail." },
          { ja: "イメージタグとチャートのバージョンから、ハッシュを作ります。", en: "The hash comes from the image tag and chart version." },
          { ja: "だから、リリースごとに新しいJobができます。", en: "So each release creates a new Job." },
        ],
        tip: "Shows you have hit a real Kubernetes gotcha (immutable fields), not just read about Helm.",
      },
    ],
    videoSearch: ["Helm 入門 チャート 作り方", "Helm Kubernetes パッケージ管理 解説"],
    docs: [
      { title: "Helm ドキュメント (日本語)", url: "https://helm.sh/ja/docs/" },
      { title: "Helm: Chart Template Guide", url: "https://helm.sh/docs/chart_template_guide/" },
    ],
    related: ["kubernetes", "kind", "argocd", "github-actions", "iam-secrets"],
  },

  // ───────────────────────────────────────────────────────────── kind
  {
    id: "kind",
    group: "platform",
    name: "kind",
    ja: `ローカルの${K8S}クラスター`,
    say: "カインド",
    oneLiner: {
      ja: `${DOCKER}のコンテナの中に、${K8S}クラスターを作るツールです。`,
      en: "It creates a Kubernetes cluster inside Docker containers.",
    },
    explain: [
      { ja: `${KIND}は、Kubernetes in Dockerの略{りゃく}です。`, en: "kind stands for Kubernetes in Docker." },
      { ja: "ノードが、Dockerのコンテナとして動きます。", en: "Each node runs as a Docker container." },
      { ja: "up.shで、クラスター作成からデプロイまで一回でできます。", en: "up.sh goes from creating the cluster to deploying in one run." },
      { ja: "kindのノードからはホストのイメージが見えないので、ロードします。", en: "kind nodes cannot see host images, so the script loads them in." },
      { ja: "Postgres、MinIO、ElasticMQは、チャートの外で起動します。", en: "Postgres, MinIO and ElasticMQ start outside the chart." },
      { ja: "本番では、RDS、S3、SQSになるからです。", en: "Because in production they become RDS, S3 and SQS." },
      { ja: "ポートマッピングで、webをlocalhost:8081で開けます。", en: "A port mapping exposes web on localhost:8081." },
    ],
    why: [
      { ja: "EKSは、最初の一時間からお金がかかります。", en: "EKS costs money from the first hour." },
      { ja: "最初のポッドの前に、VPCやIAMの準備{じゅんび}も必要です。", en: "VPC and IAM work is also needed before the first pod." },
      { ja: "kindなら、数分で作って壊{こわ}せて、費用{ひよう}はゼロです。", en: "kind can be created and destroyed in minutes, at no cost." },
      { ja: "ただ、IRSAやロードバランサーなどは確認できません。", en: "But it cannot verify things like IRSA or load balancers." },
    ],
    status: "built",
    statusNote:
      "Real: infra/kind/up.sh creates the cluster, loads the images and installs the chart locally; kind is the stand-in for EKS, which was never created.",
    inRepo: [
      { path: "infra/kind/cluster.yaml", what: "One control-plane node; maps NodePort 30080 to localhost:8081 and 30900 (MinIO) to 9100." },
      { path: "infra/kind/up.sh", what: "Idempotent bootstrap: create cluster, build and kind-load images, apply deps, helm upgrade --install." },
      { path: "infra/k8s/local/deps.yaml", what: "Postgres, MinIO and ElasticMQ as local stand-ins for RDS, S3 and SQS." },
      { path: "docs/adr/0005-local-kubernetes-before-eks.md", what: "Why kind first, and the list of what kind does not prove." },
    ],
    terms: [
      { ja: "クラスター", en: "cluster" },
      { ja: "ノード", en: "node" },
      { ja: "コントロールプレーン", en: "control plane" },
      { ja: "ポートマッピング", en: "port mapping", note: "ポートフォワード is a different thing (kubectl port-forward)." },
      { ja: "NodePort（ノードポート）", en: "NodePort Service type" },
      { ja: "イメージのロード", en: "loading an image into the cluster", note: "kind load docker-image." },
      { ja: "冪等{べきとう}", en: "idempotent", note: "up.sh is safe to re-run: 何度実行しても同じ結果になります." },
      { ja: "代替{だいたい}", en: "substitute / stand-in", note: "In speech 代わり or ローカルの代用品 also work." },
      { ja: "検証環境{けんしょうかんきょう}", en: "test / verification environment" },
    ],
    qa: [
      {
        q: { ja: "なぜEKSではなく、kindを使ったのですか？", en: "Why kind instead of EKS?" },
        a: [
          { ja: `目的は、${K8S}の運用を学んで、見せることでした。`, en: "The goal was to learn and demonstrate operating Kubernetes." },
          { ja: "EKSは、費用と、VPCやIAMの準備がかかります。", en: "EKS costs money and needs VPC and IAM setup." },
          { ja: "kindなら無料{むりょう}で、すぐ作り直せます。", en: "kind is free and quick to recreate." },
          { ja: "AWSとの違いは、values-kind.yamlに集めています。", en: "The differences from AWS are collected in values-kind.yaml." },
          { ja: "ただ、EKSで本当に動くかは、まだ検証{けんしょう}していません。", en: "But I have not yet verified that it really runs on EKS." },
        ],
        tip: "Saying exactly what is not yet proven builds trust. ADR 0005 has the list.",
      },
      {
        q: { ja: "kindでは確認できないことは何ですか？", en: "What can you not verify on kind?" },
        a: [
          { ja: "IRSAなど、本物のIAMの権限{けんげん}は確認できません。", en: "Real IAM permissions, such as IRSA." },
          { ja: "ロードバランサー、TLS、DNSもありません。", en: "There is no load balancer, TLS or DNS either." },
          { ja: "ノードの自動スケールも、対象外{たいしょうがい}です。", en: "Node autoscaling is also out of scope." },
          { ja: "RDSのネットワークやバックアップも同じです。", en: "Same for RDS networking and backups." },
          { ja: "これらは、EKSで初めて検証することになります。", en: "Those would first be verified on EKS." },
        ],
        tip: "A strong answer lists concrete gaps rather than saying 'it is basically the same'.",
      },
    ],
    videoSearch: ["kind Kubernetes ローカル 環境構築", "kind Kubernetes in Docker 入門"],
    docs: [
      { title: "kind: Quick Start", url: "https://kind.sigs.k8s.io/docs/user/quick-start/" },
      { title: "kind: Configuration (extra port mappings)", url: "https://kind.sigs.k8s.io/docs/user/configuration/" },
    ],
    related: ["kubernetes", "helm", "eks", "docker", "playwright", "s3", "sqs"],
  },

  // ───────────────────────────────────────────────────────────── eks
  {
    id: "eks",
    group: "aws",
    name: "EKS",
    ja: `マネージドな${K8S}`,
    say: "イーケーエス",
    oneLiner: {
      ja: "AWSが管理する、マネージドな" + K8S + "です。",
      en: "AWS's managed Kubernetes service.",
    },
    explain: [
      { ja: `${EKS}は、Amazon Elastic Kubernetes Serviceの略です。`, en: "EKS stands for Amazon Elastic Kubernetes Service." },
      { ja: "コントロールプレーンは、AWSが運用と冗長化{じょうちょうか}をします。", en: "AWS runs the control plane and makes it redundant." },
      { ja: "私たちは、ノードとアプリに集中{しゅうちゅう}できます。", en: "We can focus on the nodes and the app." },
      { ja: "ReelWalkでは、EKSは設計{せっけい}だけで、まだデプロイしていません。", en: "In ReelWalk, EKS is designed only and not deployed yet." },
      { ja: "同じHelmチャートを、values.yamlでEKS向けに使う想定{そうてい}です。", en: "The plan is to use the same Helm chart, with values.yaml, on EKS." },
      { ja: "ポッドには、IRSAでAWSの権限{けんげん}を渡{わた}す設計です。", en: "Pods would get AWS permissions through IRSA." },
      { ja: "静的{せいてき}なアクセスキーは使いません。", en: "No static access keys." },
    ],
    why: [
      { ja: "コントロールプレーンを自分で運用するのは大変です。", en: "Running the control plane yourself is hard work." },
      { ja: "EKSなら、可用性{かようせい}やアップグレードをAWSに任{まか}せられます。", en: "With EKS, availability and upgrades are handled by AWS." },
      { ja: "一方{いっぽう}で、コントロールプレーンだけでも費用がかかります。", en: "On the other hand, the control plane alone costs money." },
      { ja: "だから、まずkindで検証してから移{うつ}る順番にしました。", en: "So the order is: verify on kind first, then move." },
    ],
    status: "designed",
    statusNote:
      "Never deployed: the AWS account is stuck in verification. values.yaml targets a real cluster and IRSA is designed for, but the chart has only ever run on kind.",
    inRepo: [
      { path: "docs/adr/0005-local-kubernetes-before-eks.md", what: "Why kind before EKS, and what only a real EKS cluster can prove." },
      { path: "infra/helm/reelwalk/values.yaml", what: "Defaults for a real cluster: empty AWS endpoints, external Secret, the serviceAccount annotation slot for IRSA." },
    ],
    terms: [
      { ja: "マネージドサービス", en: "managed service" },
      { ja: "コントロールプレーン", en: "control plane", note: "API server, etcd, scheduler: the part AWS runs for you." },
      { ja: "ワーカーノード／ノードグループ", en: "worker nodes / node group", note: "マネージドノードグループ for EKS-managed EC2 nodes." },
      { ja: "IRSA", en: "IAM Roles for Service Accounts", note: "Said アイアールエスエー. EKS Pod Identity is the newer alternative." },
      { ja: "サービスアカウント", en: "ServiceAccount" },
      { ja: "冗長化{じょうちょうか}", en: "redundancy (making something redundant)", note: "マルチAZで冗長化する = spread across availability zones." },
      { ja: "可用性{かようせい}", en: "availability" },
      { ja: "稼働{かどう}", en: "running / in operation", note: "本番稼働 = running in production. Do not use it about ReelWalk on EKS." },
      { ja: "ロードバランサー", en: "load balancer", note: "On EKS usually an ALB via the AWS Load Balancer Controller." },
    ],
    qa: [
      {
        q: { ja: "EKSの運用経験はありますか？", en: "Do you have experience running EKS?" },
        a: [
          { ja: "正直{しょうじき}に言うと、本番のEKSはまだ運用していません。", en: "To be honest, I have not run EKS in production yet." },
          { ja: "AWSアカウントの確認が終わらず、デプロイできませんでした。", en: "My AWS account verification never completed, so I could not deploy." },
          { ja: "代わりに、同じチャートをローカルのkindで検証しました。", en: "Instead, I verified the same chart on a local kind cluster." },
          { ja: "EKS向けの差分{さぶん}は、values.yamlとIRSAの設計にまとめています。", en: "The EKS-specific differences are in values.yaml and the IRSA design." },
          { ja: "入社後{にゅうしゃご}は、実際のクラスターで早くキャッチアップしたいです。", en: "After joining I want to catch up quickly on real clusters." },
        ],
        tip: "Do not bluff: the interviewer can probe node groups, upgrades and IRSA. An honest answer with a concrete plan scores better.",
      },
      {
        q: { ja: "ポッドに、AWSの権限をどう渡しますか？", en: "How do pods get AWS permissions?" },
        a: [
          { ja: "IRSAを使う設計です。", en: "The design uses IRSA." },
          { ja: "サービスアカウントに、IAMロールのARNを付けます。", en: "The ServiceAccount is annotated with an IAM role ARN." },
          { ja: "ポッドは、短期間{たんきかん}の認証情報を自動でもらいます。", en: "Pods automatically receive short-lived credentials." },
          { ja: "アクセスキーを、Secretに入れる必要がありません。", en: "There is no need to put access keys into a Secret." },
          { ja: "values.yamlに、そのための設定欄{せっていらん}を用意しています。", en: "values.yaml already has a slot for that." },
        ],
        tip: "If they push further, mention EKS Pod Identity as the newer option, and least-privilege policies per workload.",
      },
      {
        q: { ja: "EKSに移すとき、何が必要ですか？", en: "What would moving to EKS take?" },
        a: [
          { ja: "まず、TerraformでVPC、EKS、RDSなどを作ります。", en: "First, create the VPC, EKS, RDS and so on with Terraform." },
          { ja: "次に、EKS用のvaluesファイルを用意します。", en: "Then prepare a values file for EKS." },
          { ja: "イメージは、CIからECRにプッシュします。", en: "CI pushes the images to ECR." },
          { ja: "チャートとアプリのコードは、変えない想定です。", en: "The chart and application code should not need changes." },
          { ja: "ただ、これはまだ検証していない仮説{かせつ}です。", en: "But that is an untested hypothesis." },
        ],
        tip: "ADR 0005 says exactly this: 'That claim is untested until it is done.'",
      },
    ],
    videoSearch: ["Amazon EKS 入門 解説", "EKS IRSA 解説", "AWS Black Belt Amazon EKS"],
    docs: [
      { title: "Amazon EKS とは (日本語)", url: "https://docs.aws.amazon.com/ja_jp/eks/latest/userguide/what-is-eks.html" },
      { title: "サービスアカウントの IAM ロール (IRSA)", url: "https://docs.aws.amazon.com/ja_jp/eks/latest/userguide/iam-roles-for-service-accounts.html" },
    ],
    related: ["kubernetes", "kind", "helm", "terraform", "iam-secrets", "s3", "sqs"],
  },

  // ───────────────────────────────────────────────────────────── github-actions
  {
    id: "github-actions",
    group: "delivery",
    name: "GitHub Actions",
    ja: "CI/CDパイプライン",
    say: "ギットハブアクションズ",
    oneLiner: {
      ja: "プッシュやプルリクエストのたびに、自動でテストとビルドをします。",
      en: "It tests and builds automatically on every push and pull request.",
    },
    explain: [
      { ja: `CIは、${GHA}のワークフロー一つで動いています。`, en: "CI is a single GitHub Actions workflow." },
      { ja: "プルリクエストと、mainへのプッシュで実行されます。", en: "It runs on pull requests and on pushes to main." },
      { ja: "最初のジョブで、lint、型チェック、単体テストを実行します。", en: "The first job runs lint, typecheck and unit tests." },
      { ja: "同じジョブで、Helmチャートもlintします。", en: "The same job lints the Helm chart." },
      { ja: `別のジョブで、${TRIVY}が依存関係{いぞんかんけい}と設定をスキャンします。`, en: "A separate job has Trivy scan dependencies and configuration." },
      { ja: "webとworkerのイメージは、マトリックスで並列{へいれつ}にビルドします。", en: "The web and worker images build in parallel with a matrix." },
      { ja: "ビルドしたイメージも、Trivyでスキャンします。", en: "The built images are scanned with Trivy too." },
      { ja: "最後に、Docker Composeでスタックを起動して、E2Eを流{なが}します。", en: "Finally, Docker Compose starts the stack and the E2E tests run." },
    ],
    why: [
      { ja: "コードと同じリポジトリで、パイプラインを管理できます。", en: "The pipeline lives in the same repository as the code." },
      { ja: "問題に、プルリクエストの段階{だんかい}で気{き}づけます。", en: "Problems are caught at the pull request stage." },
      { ja: "トレードオフは、E2Eに時間がかかることです。", en: "The trade-off is that E2E takes time." },
      { ja: "なので、E2Eはイメージのビルドと並列で走らせています。", en: "So E2E runs in parallel with the image builds." },
    ],
    status: "built",
    statusNote:
      "Real and green: lint, typecheck, unit tests, helm lint, Trivy scans, image builds and Playwright E2E run on every PR. On main the scanned images are pushed to GHCR and a release job commits the new image tag for Argo CD. The OIDC + ECR push steps exist but have never run because no AWS role is configured.",
    inRepo: [
      { path: ".github/workflows/ci.yml", what: "Jobs verify, dependency-scan, images (matrix web/worker, GHCR push on main), e2e and release; ECR push gated on vars.AWS_ROLE_ARN." },
      { path: "infra/helm/reelwalk/values-gitops.yaml", what: "Image repository and tag. The release job rewrites it with the commit SHA on every merge to main." },
      { path: "turbo.json", what: "The typecheck and test tasks that pnpm typecheck / pnpm test fan out across the workspace." },
      { path: "e2e/package.json", what: "Script renamed to e2e so turbo run test no longer launched the browser suite in the unit-test job." },
    ],
    terms: [
      { ja: "ワークフロー", en: "workflow" },
      { ja: "ジョブ／ステップ", en: "job / step" },
      { ja: "パイプライン", en: "pipeline" },
      { ja: "マトリックスビルド", en: "matrix build" },
      { ja: "並列{へいれつ}実行", en: "parallel execution" },
      { ja: "継続的{けいぞくてき}インテグレーション", en: "continuous integration", note: "Everyone just says シーアイ." },
      { ja: "キャッシュ", en: "cache", note: "Docker layers are cached in the GitHub Actions cache (type=gha)." },
      { ja: "成果物{せいかぶつ}", en: "artifact", note: "アーティファクト is more common in speech." },
      { ja: "OIDC", en: "OpenID Connect", note: "Said オーアイディーシー. Short-lived AWS tokens instead of stored keys." },
      { ja: "ECR", en: "Elastic Container Registry", note: "Said イーシーアール." },
      { ja: "GHCR", en: "GitHub Container Registry", note: "Said ジーエイチシーアール." },
    ],
    qa: [
      {
        q: { ja: "CI/CDで、改善{かいぜん}したことはありますか？", en: "Have you improved CI/CD in any way?" },
        a: [
          { ja: "単体テストのジョブで、E2Eが動いてしまう問題を直しました。", en: "I fixed the unit-test job accidentally running the E2E suite." },
          { ja: "e2eのスクリプト名がtestで、turboに拾{ひろ}われていました。", en: "The e2e package script was named test, so turbo picked it up." },
          { ja: "Dockerのレイヤーは、Actionsのキャッシュに保存しています。", en: "Docker layers are cached in the Actions cache." },
          { ja: "E2Eが失敗したら、ログとトレースを自動で保存します。", en: "When E2E fails, logs and traces are saved automatically." },
          { ja: "Trivyのバージョンは、一{いっ}か所{しょ}で固定{こてい}しています。", en: "Trivy's version is pinned in one place." },
        ],
        tip: "Tell one story with cause, fix and result. The turbo test-script collision (commit 1095187) is concrete and easy to explain.",
      },
      {
        q: { ja: "AWSへの認証は、どうしていますか？", en: "How does CI authenticate to AWS?" },
        a: [
          { ja: "長期間{ちょうきかん}のアクセスキーは、GitHubに置きません。", en: "No long-lived access keys are stored in GitHub." },
          { ja: "OIDCで、短期間のトークンをもらう設計です。", en: "The design gets a short-lived token via OIDC." },
          { ja: "そのため、ジョブにid-tokenの権限を付けています。", en: "That is why the job has the id-token permission." },
          { ja: "ただ、AWSのロールがまだないので、ECRへのプッシュは未実行{みじっこう}です。", en: "But there is no AWS role yet, so the ECR push has never run." },
          { ja: "今は代{か}わりに、[GHCR]{ジーエイチシーアール}にプッシュしています。", en: "For now, the images go to GHCR instead." },
          { ja: "ジョブのトークンで認証するので、ここでも鍵{かぎ}は保存しません。", en: "It authenticates with the job's own token, so no key is stored there either." },
        ],
        tip: "Be explicit that the ECR push is wired but never executed (skipped until AWS_ROLE_ARN is set), and that the GHCR push is the one that really runs.",
      },
      {
        q: { ja: "CDの部分は、どうなっていますか？", en: "What about the CD part?" },
        a: [
          { ja: "mainにマージすると、CIがイメージを[GHCR]{ジーエイチシーアール}にプッシュします。", en: "On a merge to main, CI pushes the images to GHCR." },
          { ja: "タグは、コミットのSHAです。", en: "The tag is the commit SHA." },
          { ja: "次に、CIがそのタグをvaluesファイルに書いて、コミットします。", en: "Next, CI writes that tag into a values file and commits it." },
          { ja: `${ARGO}がそのコミットを検知{けんち}して、クラスターに反映{はんえい}します。`, en: "Argo CD detects that commit and applies it to the cluster." },
          { ja: "CIは、クラスターの認証情報を持ちません。", en: "CI holds no cluster credentials." },
          { ja: "ただ、動かしているのはローカルのkindで、EKSではまだです。", en: "But this runs on local kind, not on EKS yet." },
        ],
        tip: "CI and CD are both real now, but only against a local cluster. Say that scope plainly: the registry is GHCR, and ECR and EKS are designed.",
      },
    ],
    videoSearch: ["GitHub Actions 入門 CI/CD", "GitHub Actions OIDC AWS 解説", "GitHub Actions Docker ビルド キャッシュ"],
    docs: [
      { title: "GitHub Actions ドキュメント (日本語)", url: "https://docs.github.com/ja/actions" },
      {
        title: "Amazon Web Services での OpenID Connect の構成",
        url: "https://docs.github.com/ja/actions/deployment/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services",
      },
    ],
    related: ["trivy", "vitest", "playwright", "docker", "argocd", "turborepo", "helm"],
  },

  // ───────────────────────────────────────────────────────────── argocd
  {
    id: "argocd",
    group: "delivery",
    name: "Argo CD",
    ja: "GitOpsによるデプロイ",
    say: "アルゴシーディー",
    oneLiner: {
      ja: "Gitの内容{ないよう}に、クラスターを合わせ続ける、GitOpsのツールです。",
      en: "A GitOps tool that keeps the cluster matching what is in Git.",
    },
    explain: [
      { ja: `${ARGO}は、クラスターの中で動くデプロイツールです。`, en: "Argo CD is a deployment tool that runs inside the cluster." },
      { ja: "Gitにあるマニフェストを、正しい状態として扱{あつか}います。", en: "It treats the manifests in Git as the desired state." },
      { ja: "クラスターとの差分{さぶん}を見つけると、自動で同期{どうき}します。", en: "When it finds drift from the cluster, it syncs automatically." },
      { ja: "CIがクラスターに入れるのではなく、プル型です。", en: "It is pull-based, rather than CI pushing into the cluster." },
      { ja: "ReelWalkでは、Applicationのマニフェストを書きました。", en: "For ReelWalk I wrote the Application manifest." },
      { ja: "Helmチャートとvalues-kind.yamlを、参照{さんしょう}する設定です。", en: "It points at the Helm chart and values-kind.yaml." },
      { ja: "pruneとselfHealを、有効{ゆうこう}にしています。", en: "prune and selfHeal are enabled." },
      { ja: "イメージのタグは、CIがGitに書き込{こ}みます。", en: "CI writes the image tag into Git." },
      { ja: "ローカルのkindにインストールして、動かしています。", en: "It is installed and running on local kind." },
    ],
    why: [
      { ja: "Gitが唯一{ゆいいつ}の正解になり、変更の履歴{りれき}が残ります。", en: "Git becomes the single source of truth, with a change history." },
      { ja: "ロールバックは、Gitのコミットを戻すだけです。", en: "Rolling back is just reverting a commit." },
      { ja: "CIに、クラスターの認証情報を渡さなくて済{す}みます。", en: "CI does not need cluster credentials." },
      { ja: "一方で、Argo CD自体{じたい}の運用が増えます。", en: "On the other hand, Argo CD itself must be operated." },
    ],
    status: "local",
    statusNote:
      "Running on local kind only: Argo CD v3.5.3 is installed, the Application auto-syncs main with prune and selfHeal, and a merge to main was seen rolling new GHCR images into the cluster. Never run against EKS or in production.",
    inRepo: [
      { path: "infra/argocd/application.yaml", what: "Application tracking main, path infra/helm/reelwalk with values-kind.yaml and values-gitops.yaml, automated prune and selfHeal." },
      { path: "infra/argocd/install.sh", what: "Installs Argo CD v3.5.3 into kind with server-side apply, then applies the Application." },
      { path: "infra/helm/reelwalk/values-gitops.yaml", what: "Image repository and tag, rewritten by the CI release job on every merge to main." },
      { path: "infra/helm/reelwalk/templates/migrate-job.yaml", what: "argocd.argoproj.io/sync-wave: \"-1\" so the migration completes before the Deployments sync." },
    ],
    terms: [
      { ja: "GitOps", en: "GitOps", note: "Said ギットオプス." },
      { ja: "同期{どうき}", en: "sync", note: "シンク is common in speech too." },
      { ja: "差分{さぶん}", en: "diff / drift", note: "Drift is also ドリフト; 構成{こうせい}ドリフト." },
      { ja: "自己修復{じこしゅうふく}", en: "self-healing (selfHeal)", note: "Reverts manual changes made in the cluster." },
      { ja: "プルーン", en: "prune", note: "Deletes resources that were removed from Git." },
      { ja: "宣言的{せんげんてき}", en: "declarative" },
      { ja: "唯一{ゆいいつ}の情報源{じょうほうげん}", en: "single source of truth", note: "Engineers often say シングルソースオブトゥルース or just 正{せい}とする." },
      { ja: "プル型／プッシュ型", en: "pull-based / push-based deployment" },
      { ja: "後方互換{こうほうごかん}", en: "backward compatibility", note: "Key for safe rollbacks with database migrations." },
    ],
    qa: [
      {
        q: { ja: "GitOpsとは、何ですか？", en: "What is GitOps?" },
        a: [
          { ja: "Gitを、デプロイの唯一の正解にするやり方です。", en: "It makes Git the single source of truth for deployment." },
          { ja: "クラスターの状態を、Gitのマニフェストに合わせます。", en: "The cluster is kept matching the manifests in Git." },
          { ja: "手で変えた設定は、自動で元{もと}に戻ります。", en: "Manual changes are reverted automatically." },
          { ja: "変更は全部プルリクエストなので、レビューと履歴が残ります。", en: "Every change is a pull request, so it is reviewed and recorded." },
        ],
        tip: "Contrast push (CI runs kubectl/helm with cluster credentials) and pull (an agent in the cluster watches Git).",
      },
      {
        q: { ja: `${ARGO}は、実際に使っていますか？`, en: "Are you actually using Argo CD?" },
        a: [
          { ja: "はい、ローカルのkindで使っています。", en: "Yes, on local kind." },
          { ja: "mainにマージすると、新しいイメージが自動でデプロイされます。", en: "When I merge to main, the new images are deployed automatically." },
          { ja: "ただ、本番での運用経験はまだありません。", en: "But I have no production experience with it yet." },
          { ja: "マイグレーションのJobには、sync-waveを付けています。", en: "The migration Job has a sync-wave annotation." },
          { ja: "Deploymentより先に、Jobが終わるようにするためです。", en: "So the Job finishes before the Deployments sync." },
        ],
        tip: "Scope first (local kind, not production), then one detail (sync-wave -1) that shows you understand ordering.",
      },
      {
        q: { ja: "ロールバックは、どうしますか？", en: "How do you roll back?" },
        a: [
          { ja: "Gitで、前のコミットにrevertします。", en: "Revert to the previous commit in Git." },
          { ja: "Argo CDがそれを検知{けんち}して、前の状態に戻します。", en: "Argo CD detects it and restores the previous state." },
          { ja: "ただし、DBのマイグレーションは自動では戻りません。", en: "But database migrations do not roll back automatically." },
          { ja: "なので、マイグレーションは後方互換{こうほうごかん}を保{たも}つことが大事です。", en: "So migrations must stay backward compatible." },
        ],
        tip: "The database is the hard part of any rollback; mentioning expand-and-contract migrations is a plus.",
      },
    ],
    videoSearch: ["Argo CD 入門 GitOps", "GitOps 解説 Kubernetes"],
    docs: [
      { title: "Argo CD documentation", url: "https://argo-cd.readthedocs.io/en/stable/" },
      { title: "Argo CD: Sync Phases and Waves", url: "https://argo-cd.readthedocs.io/en/stable/user-guide/sync-waves/" },
    ],
    related: ["helm", "github-actions", "kubernetes", "kind", "prisma"],
  },

  // ───────────────────────────────────────────────────────────── terraform
  {
    id: "terraform",
    group: "aws",
    name: "Terraform",
    ja: "インフラのコード化（IaC）",
    say: "テラフォーム",
    oneLiner: {
      ja: "AWSのリソースを、コードで定義{ていぎ}して作るツールです。",
      en: "It defines and creates AWS resources as code.",
    },
    explain: [
      { ja: `${TF}は、インフラをコードで書く、IaCのツールです。`, en: "Terraform is an IaC tool: infrastructure written as code." },
      { ja: "HCLという言語で、欲{ほ}しい状態を宣言的{せんげんてき}に書きます。", en: "You declare the desired state in a language called HCL." },
      { ja: "planで差分{さぶん}を確認して、applyで反映{はんえい}します。", en: "plan shows the diff and apply makes the change." },
      { ja: "ReelWalkでは、S3、SQS、CloudFrontを定義しています。", en: "ReelWalk defines S3, SQS and CloudFront." },
      { ja: "RDSやECSも、プレースホルダーとして書いてあります。", en: "RDS and ECS are written as placeholders too." },
      { ja: "ただ、一度もapplyしていません。", en: "But it has never been applied." },
      { ja: "初期の下書{したが}きなので、今の設計とずれています。", en: "It is an early draft, so it differs from the current design." },
    ],
    why: [
      { ja: "手作業{てさぎょう}の設定は、再現{さいげん}もレビューもできません。", en: "Manual setup can be neither reproduced nor reviewed." },
      { ja: "コードなら、プルリクエストで変更をレビューできます。", en: "As code, changes are reviewed in pull requests." },
      { ja: "一方で、stateファイルを安全に管理する必要があります。", en: "On the other hand, the state file must be managed safely." },
    ],
    status: "designed",
    statusNote:
      "Written, never applied: an early sketch (S3, SQS, CloudFront, plus ECS/RDS/ElastiCache placeholders) that predates the Kubernetes design, has no DLQ or EKS, no remote state, and is skipped by CI's config scan.",
    inRepo: [
      { path: "infra/terraform/main.tf", what: "S3 bucket, SQS queue (no DLQ yet), CloudFront in front of S3, and ECS/RDS/Redis placeholders." },
      { path: "infra/terraform/variables.tf", what: "Region, project and bucket name variables." },
      { path: "docs/adr/0004-kubernetes-and-helm.md", what: "Notes that the Terraform started as an ECS/Fargate design before Kubernetes was chosen." },
    ],
    terms: [
      { ja: "IaC", en: "Infrastructure as Code", note: "Said アイエーシー. Kanji gloss: コードによるインフラ管理." },
      { ja: "プロバイダー", en: "provider", note: "hashicorp/aws." },
      { ja: "リソース", en: "resource" },
      { ja: "state（ステート）", en: "state file", note: "Remote state in S3 with locking is the usual team setup." },
      { ja: "plan／apply", en: "plan / apply", note: "プランを確認してからアプライする." },
      { ja: "差分{さぶん}", en: "diff" },
      { ja: "ドリフト", en: "drift (real infra differs from code)" },
      { ja: "再現性{さいげんせい}", en: "reproducibility" },
      { ja: "定義{ていぎ}", en: "definition", note: "コードで定義する." },
    ],
    qa: [
      {
        q: { ja: `${TF}で、何を管理していますか？`, en: "What do you manage with Terraform?" },
        a: [
          { ja: "メディア用のS3バケットと、SQSのキューです。", en: "The S3 bucket for media and the SQS queue." },
          { ja: "S3の前に置く、CloudFrontも書きました。", en: "I also wrote CloudFront in front of S3." },
          { ja: "RDSやECSは、まだプレースホルダーです。", en: "RDS and ECS are still placeholders." },
          { ja: "ただ、一度もapplyしていない、設計段階{せっけいだんかい}のコードです。", en: "But it is design-stage code that has never been applied." },
        ],
        tip: "Do not imply it is live. CI even skips infra/terraform in the Trivy config scan because it is not applied.",
      },
      {
        q: { ja: "今のTerraformの課題は、何ですか？", en: "What are the problems with the current Terraform?" },
        a: [
          { ja: "初期に書いたので、今の構成{こうせい}とずれています。", en: "It was written early, so it no longer matches the architecture." },
          { ja: "ECSやRedisがありますが、今はKubernetesで、Redisは使いません。", en: "It has ECS and Redis, but we now use Kubernetes and no Redis." },
          { ja: "SQSのDLQも、まだ定義していません。", en: "The SQS DLQ is not defined yet either." },
          { ja: "stateは、S3に置いてロックする予定です。", en: "State is planned to live in S3 with locking." },
          { ja: "EKSとVPCの定義も、これから追加{ついか}します。", en: "EKS and VPC definitions still need to be added." },
        ],
        tip: "Self-critique is well received in Japanese interviews; it shows you know what 'done' looks like.",
      },
      {
        q: { ja: "TerraformとHelmは、どう役割{やくわり}を分けますか？", en: "How do you split responsibilities between Terraform and Helm?" },
        a: [
          { ja: "Terraformは、AWSの土台{どだい}を作ります。", en: "Terraform builds the AWS foundation." },
          { ja: "VPC、EKS、RDS、S3、SQSなどです。", en: "VPC, EKS, RDS, S3, SQS and so on." },
          { ja: "Helmは、その上にアプリをデプロイします。", en: "Helm deploys the app on top of it." },
          { ja: "変更の頻度{ひんど}が違うので、分けて管理します。", en: "They change at different rates, so they are managed separately." },
        ],
        tip: "Lifecycle separation is the key idea: infrastructure changes rarely, the app changes every release.",
      },
    ],
    videoSearch: ["Terraform 入門 AWS", "Terraform state 管理 解説"],
    docs: [
      { title: "What is Terraform?", url: "https://developer.hashicorp.com/terraform/intro" },
      { title: "Terraform AWS Provider", url: "https://registry.terraform.io/providers/hashicorp/aws/latest/docs" },
    ],
    related: ["eks", "s3", "sqs", "cloudfront", "retries-dlq", "iam-secrets", "postgresql"],
  },

  // ───────────────────────────────────────────────────────────── trivy
  {
    id: "trivy",
    group: "quality",
    name: "Trivy",
    ja: "脆弱性{ぜいじゃくせい}スキャン",
    say: "トリビー",
    oneLiner: {
      ja: "依存関係{いぞんかんけい}、設定、イメージの脆弱性{ぜいじゃくせい}をスキャンします。",
      en: "It scans dependencies, configuration and images for vulnerabilities.",
    },
    explain: [
      { ja: `${TRIVY}は、オープンソースのセキュリティスキャナーです。`, en: "Trivy is an open-source security scanner." },
      { ja: "CIでは、三つのものをスキャンしています。", en: "In CI it scans three things." },
      { ja: "一つ目は、pnpmのロックファイルの依存関係です。", en: "First, the dependencies in the pnpm lockfile." },
      { ja: "二つ目は、DockerfileとHelmチャートの設定ミスです。", en: "Second, misconfigurations in the Dockerfiles and Helm chart." },
      { ja: "三つ目は、ビルドしたwebとworkerのイメージです。", en: "Third, the built web and worker images." },
      { ja: "HIGHかCRITICALが見つかると、CIが失敗します。", en: "A HIGH or CRITICAL finding fails CI." },
      { ja: "修正版{しゅうせいばん}がないものは、除外{じょがい}しています。", en: "Findings with no fixed version are excluded." },
      { ja: "許容{きょよう}した指摘{してき}は、理由と一緒にファイルに残します。", en: "Accepted findings are recorded in a file with the reason." },
    ],
    why: [
      { ja: "脆弱性に、デプロイの前に気づけます。", en: "Vulnerabilities are caught before deployment." },
      { ja: "サードパーティのActionではなく、公式のイメージで動かしています。", en: "It runs from the official image, not a third-party Action." },
      { ja: "バージョンを、一か所で固定できるからです。", en: "That pins the version in one place." },
      { ja: "トレードオフは、直せない指摘でCIが止まることです。", en: "The trade-off is CI blocking on findings you cannot fix." },
    ],
    status: "built",
    statusNote:
      "Real: three Trivy scans (lockfile, config, images) gate every CI run at HIGH/CRITICAL; real findings were fixed in commits be7eb1c and c317ca1, and accepted ones are documented in .trivyignore.yaml.",
    inRepo: [
      { path: ".github/workflows/ci.yml", what: "TRIVY_IMAGE pinned to 0.75.0; fs, config and image scans with --exit-code 1." },
      { path: ".trivyignore.yaml", what: "Accepted DS-0002 (root user) findings, each with a written statement: local nginx images, a backup Dockerfile, the GPU splat image." },
      { path: "package.json", what: "pnpm overrides for mysql2 and deepmerge-ts, transitive packages pinned by the Prisma CLI." },
      { path: "apps/worker/Dockerfile", what: "The fix for the image findings: --prod install and package managers removed from the runner." },
    ],
    terms: [
      { ja: "脆弱性{ぜいじゃくせい}", en: "vulnerability", note: "The standard word; 脆弱性対応 = vulnerability handling, as in the job listing." },
      { ja: "CVE", en: "Common Vulnerabilities and Exposures ID", note: "Said シーブイイー." },
      { ja: "深刻度{しんこくど}", en: "severity", note: "HIGH and CRITICAL are read in English." },
      { ja: "設定ミス", en: "misconfiguration", note: "Trivy's own term is ミスコンフィギュレーション." },
      { ja: "誤検知{ごけんち}", en: "false positive" },
      { ja: "許容{きょよう}", en: "accepting (a risk)", note: "リスク受容{じゅよう} is the formal term." },
      { ja: "推移的{すいいてき}依存", en: "transitive dependency", note: "間接的{かんせつてき}な依存 is easier to say." },
      { ja: "サプライチェーン攻撃", en: "supply-chain attack" },
      { ja: "修正版{しゅうせいばん}", en: "fixed version", note: "For --ignore-unfixed: 修正版がまだない脆弱性は除外." },
      { ja: "除外{じょがい}", en: "exclusion / ignore" },
    ],
    qa: [
      {
        q: { ja: "脆弱性が見つかったら、どう対応しますか？", en: "How do you handle a vulnerability when one is found?" },
        a: [
          { ja: "まず、本当に使われている部分かを確認します。", en: "First I check whether the affected code is actually used." },
          { ja: "実際に、TrivyでHIGHとCRITICALが出たことがあります。", en: "Trivy actually did report HIGH and CRITICAL findings." },
          { ja: "古いnpmのロックファイルが、脆弱{ぜいじゃく}なNext.jsを固定していました。", en: "A stale npm lockfile pinned a vulnerable Next.js." },
          { ja: "使っていないファイルだったので、削除しました。", en: "It was unused, so I deleted it." },
          { ja: "Prismaが固定する依存は、pnpmのoverridesで上げました。", en: "Dependencies pinned by Prisma were raised with pnpm overrides." },
          { ja: "最後に、CIがグリーンになることを確認しました。", en: "Then I confirmed CI went green." },
        ],
        tip: "This is a listed job duty. Use the flow: triage (used? fix available?) -> fix or remove -> verify in CI -> record any exception. Commit be7eb1c.",
      },
      {
        q: { ja: "イメージのスキャンでは、何が見つかりましたか？", en: "What did the image scan find?" },
        a: [
          { ja: "同梱{どうこん}されたnpmや、pnpmのストアに指摘がありました。", en: "There were findings in the bundled npm and the pnpm store." },
          { ja: "テスト用ツールが入れた、古いesbuildもありました。", en: "Also old esbuild builds pulled in by test tooling." },
          { ja: "どれも、実行時には使っていないものでした。", en: "None of it was used at runtime." },
          { ja: "なので、本番用の依存だけを入れるようにしました。", en: "So I made the image install production dependencies only." },
          { ja: "使わないパッケージマネージャーも、消しました。", en: "And removed the unused package managers." },
        ],
        tip: "Removing what is not needed beats upgrading it: it shrinks the attack surface. Commit c317ca1.",
      },
      {
        q: { ja: "すべての指摘を、直すべきですか？", en: "Should every finding be fixed?" },
        a: [
          { ja: "いいえ、リスクを見て判断します。", en: "No, I decide based on risk." },
          { ja: "例えば、nginxのイメージがrootで動くと指摘されました。", en: "For example, an nginx image was flagged for running as root." },
          { ja: "でも、ローカルのCompose専用で、デプロイはしません。", en: "But it is only for local Compose and is never deployed." },
          { ja: "なので、理由を書いて、許容しました。", en: "So I accepted it with a written reason." },
          { ja: "非rootのイメージへの切{き}り替{か}えは、課題として残しています。", en: "Switching to a non-root image is tracked as follow-up." },
        ],
        tip: "They are checking you do not silently suppress findings: every entry in .trivyignore.yaml has a statement, and the scan scope (skipping local-only and unapplied dirs) is commented in ci.yml.",
      },
    ],
    videoSearch: ["Trivy 脆弱性スキャン 使い方", "コンテナ 脆弱性 スキャン CI", "Trivy GitHub Actions"],
    docs: [
      { title: "Trivy documentation", url: "https://trivy.dev/latest/" },
      { title: "Trivy: Filtering (ignore files)", url: "https://trivy.dev/latest/docs/configuration/filtering/" },
    ],
    related: ["docker", "github-actions", "helm", "nextjs", "prisma"],
  },

  // ───────────────────────────────────────────────────────────── vitest
  {
    id: "vitest",
    group: "quality",
    name: "Vitest",
    ja: "単体{たんたい}テスト",
    say: "ヴィテスト",
    oneLiner: {
      ja: "ロジックを、速い単体{たんたい}テストで確認するツールです。",
      en: "It checks logic with fast unit tests.",
    },
    explain: [
      { ja: `${VITEST}は、Viteベースの速いテストランナーです。`, en: "Vitest is a fast test runner built on Vite." },
      { ja: "Jestと、ほぼ同じ書き方ができます。", en: "You write tests almost the same way as in Jest." },
      { ja: "ReelWalkでは、主{おも}にcoreパッケージをテストしています。", en: "In ReelWalk it mainly tests the core package." },
      { ja: "書き出しジョブの、状態遷移{じょうたいせんい}が正しいかを確認します。", en: "It checks that render job state transitions are correct." },
      { ja: "キューのメッセージを、処理するか捨{す}てるかの判断もテストします。", en: "It tests the decision to process or discard a queue message." },
      { ja: "アップロードできるファイルの種類も、テストしています。", en: "It also tests which file types can be uploaded." },
      { ja: "workerのハンドラーは、DBやS3をモックしてテストします。", en: "The worker handler is tested with the database and S3 mocked." },
      { ja: "CIでは、turbo run testで全部のパッケージを実行します。", en: "CI runs every package through turbo run test." },
    ],
    why: [
      { ja: "判断のロジックを、純粋{じゅんすい}な関数に分けました。", en: "Decision logic is split out into pure functions." },
      { ja: "だから、DBやキューなしで、すぐテストできます。", en: "So it can be tested instantly without a database or queue." },
      { ja: "ただ、本物のChromeやSQSの動きは確認できません。", en: "But it cannot check real Chrome or SQS behaviour." },
      { ja: "そこは、PlaywrightのE2Eで補{おぎな}っています。", en: "Playwright E2E covers that." },
    ],
    status: "built",
    statusNote: "Real: Vitest suites in packages/core, packages/render and apps/worker run in CI's verify job on every push.",
    inRepo: [
      { path: "packages/core/tests/job-status.test.ts", what: "Allowed transitions: happy path, retries, SUCCEEDED is final, the worker cannot be skipped." },
      { path: "packages/core/tests/queue.test.ts", what: "decideDelivery (claim, duplicate, stale heartbeat), decideFailure exponential backoff, dead-letter handling." },
      { path: "packages/core/tests/uploads.test.ts", what: "Upload type resolution and object key rules." },
      { path: "apps/worker/tests/handler.test.ts", what: "handleDelivery and handleDeadLetter with vi.fn mocks: no double render, re-queue with backoff, DLQ on last attempt." },
    ],
    terms: [
      { ja: "単体{たんたい}テスト", en: "unit test", note: "ユニットテスト is equally common." },
      { ja: "テストランナー", en: "test runner" },
      { ja: "モック", en: "mock", note: "モックする is the verb; スタブ for canned responses." },
      { ja: "状態遷移{じょうたいせんい}", en: "state transition" },
      { ja: "純粋関数{じゅんすいかんすう}", en: "pure function" },
      { ja: "副作用{ふくさよう}", en: "side effect" },
      { ja: "アサーション", en: "assertion" },
      { ja: "デグレ", en: "regression", note: "Japanese engineering slang from デグレード; 回帰{かいき} is the formal word." },
      { ja: "網羅{もうら}", en: "covering exhaustively", note: "テストで網羅する; カバレッジ for coverage." },
      { ja: "指数{しすう}バックオフ", en: "exponential backoff" },
    ],
    qa: [
      {
        q: { ja: "どんな単体テストを書きましたか？", en: "What kind of unit tests did you write?" },
        a: [
          { ja: "一番大事なのは、ジョブの状態遷移のテストです。", en: "The most important are the job state transition tests." },
          { ja: "成功したジョブが、他の状態に戻らないことを確認します。", en: "They check that a succeeded job never leaves that state." },
          { ja: "同じメッセージが二回{にかい}届{とど}いても、二回書き出しません。", en: "A message delivered twice is not rendered twice." },
          { ja: "失敗したら、指数バックオフで再試行{さいしこう}することも確認します。", en: "They also check that failures retry with exponential backoff." },
        ],
        tip: "Tie it to idempotency: SQS is at-least-once, and the tests prove duplicates are harmless.",
      },
      {
        q: { ja: "テストしやすくするために、工夫したことは？", en: "What did you do to make the code easy to test?" },
        a: [
          { ja: "判断と副作用{ふくさよう}を分けました。", en: "I separated decisions from side effects." },
          { ja: "decideDeliveryは、何をするかを返すだけです。", en: "decideDelivery only returns what to do." },
          { ja: "DBの更新やS3は、ハンドラー側{がわ}で行います。", en: "Database updates and S3 happen in the handler." },
          { ja: "ハンドラーのテストでは、それをvi.fnでモックします。", en: "The handler tests mock those with vi.fn." },
        ],
        tip: "'Functional core, imperative shell' is the idea; you don't need the English phrase, just the split.",
      },
      {
        q: { ja: "単体テストとE2Eは、どう使い分けますか？", en: "How do you divide work between unit tests and E2E?" },
        a: [
          { ja: "ロジックの組み合わせは、単体テストで網羅{もうら}します。", en: "Logic combinations are covered by unit tests." },
          { ja: "速いので、ケースをたくさん書けます。", en: "They are fast, so I can write many cases." },
          { ja: "E2Eは、ユーザーの大事な流れだけにしています。", en: "E2E covers only the important user flows." },
          { ja: "遅いので、数を絞{しぼ}っています。", en: "They are slow, so I keep them few." },
        ],
        tip: "This is the test pyramid; mentioning it by name (テストピラミッド) is fine.",
      },
    ],
    videoSearch: ["Vitest 入門", "TypeScript 単体テスト Vitest モック"],
    docs: [
      { title: "Vitest: Getting Started", url: "https://vitest.dev/guide/" },
      { title: "Vitest: Mocking", url: "https://vitest.dev/guide/mocking" },
    ],
    related: ["job-states", "idempotency", "retries-dlq", "worker", "playwright", "turborepo", "typescript-react"],
  },

  // ───────────────────────────────────────────────────────────── playwright
  {
    id: "playwright",
    group: "quality",
    name: "Playwright",
    ja: "E2Eテスト",
    say: "プレイライト",
    oneLiner: {
      ja: "本物のブラウザで、ユーザーの操作{そうさ}を最後まで自動テストします。",
      en: "It tests user flows end to end in a real browser.",
    },
    explain: [
      { ja: `${PW}は、ブラウザを自動で操作するテストツールです。`, en: "Playwright is a test tool that drives a browser automatically." },
      { ja: "本物のChromiumで、画面を操作してテストします。", en: "It operates the UI in a real Chromium." },
      { ja: "ReelWalkはスマホ向けなので、Pixel 7の画面サイズで実行します。", en: "ReelWalk is for phones, so tests run at a Pixel 7 viewport." },
      { ja: "メインのテストは、写真と動画からリールを作ります。", en: "The main test makes a reel from photos and a video." },
      { ja: "最後に本当に書き出して、MP4が取れるかを確認します。", en: "Then it really renders and checks the MP4 can be fetched." },
      { ja: "壊れた動画で、リトライ後に失敗する流れもテストします。", en: "A corrupt video tests failing after retries." },
      { ja: "CIでは、Docker Composeで全部のサービスを起動して流します。", en: "In CI, Docker Compose starts every service and the suite runs." },
      { ja: "ローカルでは、並列数{へいれつすう}を2にしています。", en: "Locally, parallelism is set to 2." },
    ],
    why: [
      { ja: "単体テストでは、サービス間{かん}のつながりを確認できません。", en: "Unit tests cannot check how the services connect." },
      { ja: "E2Eなら、web、キュー、worker、S3まで通{とお}して確認できます。", en: "E2E checks the whole path: web, queue, worker and S3." },
      { ja: "トレードオフは、遅くて不安定{ふあんてい}になりやすいことです。", en: "The trade-off is that they are slow and prone to flakiness." },
      { ja: "なので、CIでは一回だけリトライして、トレースを残します。", en: "So CI retries once and keeps traces." },
    ],
    status: "built",
    statusNote:
      "Real: the suite runs in CI against Docker Compose, including a real render to MP4; it can also point at the kind cluster via E2E_BASE_URL.",
    inRepo: [
      { path: "e2e/playwright.config.ts", what: "Pixel 7 project, 5-minute timeout, 2 workers by default (the Windows 10 s stall note), 1 retry and traces on CI." },
      { path: "e2e/tests/reels.spec.ts", what: "Create, edit and export a reel; Instagram limits; conflict between tabs; corrupt video fails then retries." },
      { path: "e2e/fixtures/corrupt.mp4", what: "A file that passes upload checks but cannot be decoded, to drive the retry and DLQ path." },
    ],
    terms: [
      { ja: "E2Eテスト", en: "end-to-end test", note: "Said イーツーイー. Kanji-ish alternative: 結合{けつごう}テスト is broader (integration)." },
      { ja: "ヘッドレスブラウザ", en: "headless browser" },
      { ja: "ロケーター", en: "locator" },
      { ja: "自動待機{じどうたいき}", en: "auto-waiting", note: "Playwright waits for elements and assertions instead of fixed sleeps." },
      { ja: "フレーキー", en: "flaky", note: "不安定なテスト; フレーキーテスト is the common term." },
      { ja: "トレース", en: "trace", note: "trace: retain-on-failure keeps a replayable trace for failed tests." },
      { ja: "並列{へいれつ}実行／ワーカー数", en: "parallel execution / number of workers" },
      { ja: "ビューポート", en: "viewport" },
      { ja: "切{き}り分{わ}け", en: "isolating the cause (troubleshooting)", note: "原因の切り分け is the key phrase for debugging stories." },
    ],
    qa: [
      {
        q: { ja: "E2Eテストでは、何を確認していますか？", en: "What do your E2E tests check?" },
        a: [
          { ja: "ユーザーの流れを、ブラウザで最初から最後まで通します。", en: "They run user flows in the browser from start to finish." },
          { ja: "リールを作って、編集して、書き出すまでです。", en: "Making a reel, editing it and exporting it." },
          { ja: "書き出しは本物で、workerがMP4を作ります。", en: "The render is real: the worker produces an MP4." },
          { ja: "MP4の形式で、50KBより大きいことも確認します。", en: "It checks the file is MP4 and larger than 50 KB." },
          { ja: "失敗のケースは、壊れた動画で確認しています。", en: "Failure cases use a corrupt video." },
        ],
        tip: "Stress 'no mocks': the E2E goes through SQS (ElasticMQ), the worker, Chrome and S3 (MinIO).",
      },
      {
        q: { ja: "なぜローカルでは、ワーカー数を2にしたのですか？", en: "Why two workers locally?" },
        a: [
          { ja: "5並列だと、リクエストがちょうど10秒ずつ止まりました。", en: "With five in parallel, requests stalled in exact 10-second steps." },
          { ja: "MinIOに直接送っても同じで、アプリの問題ではありませんでした。", en: "It happened even straight to MinIO, so it was not the app." },
          { ja: "WindowsからDocker Desktopへの通信で起きていました。", en: "It happened between the Windows host and Docker Desktop." },
          { ja: "LinuxのCIでは起きないので、ローカルだけ2にしました。", en: "Linux CI is unaffected, so only local runs use 2." },
          { ja: "根本原因{こんぽんげんいん}は、まだ調査中{ちょうさちゅう}です。", en: "The root cause is still under investigation." },
        ],
        tip: "A good debugging story: you isolated the layer (原因の切り分け) before blaming the app. Don't claim a root cause you haven't found.",
      },
      {
        q: { ja: "フレーキーなテストを、どう防{ふせ}ぎますか？", en: "How do you prevent flaky tests?" },
        a: [
          { ja: "固定の待ち時間ではなく、状態を待ちます。", en: "Wait for state, not for a fixed time." },
          { ja: "例えば、data-statusがSUCCEEDEDになるまで待ちます。", en: "For example, wait until data-status becomes SUCCEEDED." },
          { ja: "要素は、data-testidやロールで探{さが}します。", en: "Elements are found by data-testid or role." },
          { ja: "CIでは一回だけリトライして、失敗時はトレースを残します。", en: "CI retries once and keeps a trace on failure." },
        ],
        tip: "Retries hide flakiness if overused; one retry plus a trace to investigate is a reasonable balance.",
      },
    ],
    videoSearch: ["Playwright 入門 E2Eテスト", "Playwright TypeScript 使い方"],
    docs: [
      { title: "Playwright: Installation / Intro", url: "https://playwright.dev/docs/intro" },
      { title: "Playwright: Parallelism", url: "https://playwright.dev/docs/test-parallel" },
    ],
    related: ["vitest", "github-actions", "kind", "worker", "retries-dlq", "s3", "sqs"],
  },
];
