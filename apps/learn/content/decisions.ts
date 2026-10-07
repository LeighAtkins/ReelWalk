/**
 * The architecture decisions (docs/adr), in plain English for interview
 * practice: what was decided, why, what was rejected, and what it costs.
 * Keep in step with the ADRs; they are the source.
 */

export interface Decision {
  adr: string;
  title: string;
  problem: string;
  decision: string[];
  why: string[];
  rejected: { option: string; reason: string }[];
  costs: string[];
  /** How you might say it in an interview, in one breath. */
  oneLine: string;
}

export const DECISIONS: Decision[] = [
  {
    adr: "0001",
    title: "SQS for the render queue",
    problem:
      "A render takes seconds to minutes, uses a lot of CPU and memory, and can crash its process. It can't run inside a web request. The first version used a Redis list with LPOP, which lost the job whenever a worker died mid-render and had no retries or dead-letter handling.",
    decision: [
      "Use SQS (ElasticMQ locally, same API) with a dead-letter queue.",
      "The message carries only { jobId, generation }. Postgres is the source of truth for everything else.",
      "While rendering, the worker extends the message's visibility timeout and writes a heartbeat to the job row. If the worker dies, both lapse and the message is delivered again.",
      "A failed attempt re-queues the job with exponential backoff by setting the visibility timeout. After 3 receives, SQS moves the message to the dead-letter queue.",
      "A small consumer on the dead-letter queue marks the job FAILED if it is still QUEUED or RUNNING, covering workers that crashed before recording the failure.",
    ],
    why: [
      "SQS gives a lease (visibility timeout), a receive count and a dead-letter queue out of the box.",
      "The tiny message can never disagree with the database.",
    ],
    rejected: [
      { option: "Redis list", reason: "No visibility timeout, receive count or dead-letter queue; all would be hand-built." },
      { option: "Postgres as a queue (SKIP LOCKED)", reason: "Works at this scale, but long renders hold a transaction or need a hand-written lease. SQS already is that lease." },
      { option: "One Kubernetes Job per render", reason: "Good isolation, but slow start per job and the API server becomes the queue." },
    ],
    costs: [
      "At-least-once delivery, so the worker must be idempotent (ADR 0003).",
      "Max attempts in the worker and maxReceiveCount on the queue must match, and are set in two places.",
      "The job row and the message live in two systems; they are kept consistent with a transactional outbox (ADR 0010).",
    ],
    oneLine:
      "I used SQS because renders are long and can crash, and SQS gives me a lease, retries and a dead-letter queue for free; the cost is at-least-once delivery, so the worker is idempotent.",
  },
  {
    adr: "0002",
    title: "PostgreSQL with Prisma",
    problem:
      "The data is relational (workspace, media, reels, render jobs, outputs) and job status changes must be safe when two workers, or a worker and a user, act on the same job at once.",
    decision: [
      "PostgreSQL, accessed through Prisma from both the web app and the worker; schema, migrations and client live in packages/db.",
      "Status changes are single conditional updates, e.g. updateMany where { id, generation, status: RUNNING }. If someone else got there first, zero rows change. No read-then-write, no explicit locks.",
      "Legal transitions are a pure function in packages/core, tested with Vitest; the conditional updates mirror it.",
      "Migrations are committed SQL, applied by a one-shot Kubernetes Job (prisma migrate deploy) before the app rolls out.",
    ],
    why: ["Relations and constraints fit the data.", "Generated types are shared by the web app and the worker."],
    rejected: [
      { option: "DynamoDB", reason: "No joins, and access patterns aren't stable enough yet to design keys around." },
      { option: "Raw SQL (asyncpg, the first version)", reason: "Fine, but no generated types shared between web and worker." },
    ],
    costs: [
      "Prisma 7 generates its client into the repo, so prisma generate must run before typecheck, test and build; Turborepo encodes that.",
      "Production would use RDS: only DATABASE_URL changes. Not yet deployed.",
    ],
    oneLine:
      "Postgres is the source of truth because the data is relational, and every status change is one conditional update, so two writers can never both win.",
  },
  {
    adr: "0003",
    title: "Separate, idempotent render workers",
    problem:
      "The web app is small and I/O bound; a render runs headless Chrome and ffmpeg and needs gigabytes of memory. They scale, fail and package differently (about 230 MB vs 1.7 GB images).",
    decision: [
      "Two deployables from one repo: apps/web (writes the job and sends the message) and apps/worker (receives and renders). They share code through packages, not HTTP.",
      "Output key is renders/<jobId>.mp4, so a second render overwrites the same object.",
      "RenderOutput.jobId is unique and written with an upsert.",
      "A delivery for a SUCCEEDED or FAILED job is deleted without rendering; one for a job with a fresh heartbeat is left alone.",
      "A manual retry increments generation, so messages from an older generation are discarded.",
    ],
    why: ["A web deploy never interrupts a render, and an out-of-memory render never takes the site down.", "One render per pod keeps memory predictable; throughput scales by adding pods."],
    rejected: [{ option: "Rendering inside the web app", reason: "Long, memory-hungry work would block requests and crash the site with the render." }],
    costs: [
      "On SIGTERM the worker stops polling and finishes its job; if it's killed first, the job is picked up again after the visibility timeout.",
      "No per-claim fencing token yet: a worker wrongly judged dead could still write SUCCEEDED, which is harmless here because the output is identical.",
    ],
    oneLine:
      "The worker is separate because rendering scales and fails differently from the web app, and it's idempotent because the queue can deliver a job twice.",
  },
  {
    adr: "0004",
    title: "Kubernetes with a Helm chart",
    problem:
      "Three workloads: a web app that must stay up during deploys, workers whose number should follow the queue, and a migration that runs once per release. Docker Compose has no rollout, health-based restarts or scaling.",
    decision: [
      "web: Deployment with 2 replicas, rolling update with maxUnavailable 0, and a Service. Readiness checks the database and migrations; liveness only checks the process answers.",
      "worker: Deployment with no Service, liveness fed by the poll loop, memory-backed /dev/shm for Chrome, long termination grace period.",
      "migrate: a Job named with a hash of image tag and chart version, because a Job's pod template is immutable.",
      "ConfigMap and Secret via envFrom, with a checksum annotation that rolls pods when either changes.",
      "Requests and limits, non-root, read-only root filesystem, no privilege escalation, all capabilities dropped.",
    ],
    why: ["The same manifests run on a laptop (kind) and would run on EKS.", "Helm values make the local and AWS differences explicit, one file each."],
    rejected: [
      { option: "ECS/Fargate", reason: "Less to operate and reasonable at this size, but not portable to a local cluster." },
      { option: "Plain manifests or Kustomize", reason: "Fine for one environment; values files describe the differences more clearly." },
    ],
    costs: [
      "Readiness vs liveness split: a database outage takes pods out of rotation instead of restarting them.",
      "Worker autoscaling is CPU-based and off by default; KEDA on queue depth is the planned improvement.",
      "In production the Secret comes from outside the chart; on EKS pods got AWS access through Pod Identity, which ran for one day (ADR 0014).",
    ],
    oneLine:
      "Kubernetes gives me rolling updates, probes and separate scaling for web and worker, and Helm lets the same chart run on kind locally and, as it turned out, on EKS with one values file.",
  },
  {
    adr: "0005",
    title: "kind before EKS",
    problem: "EKS costs money from the first hour and needs VPC, IAM and add-ons before the first pod starts; the AWS account is also not available yet.",
    decision: [
      "Run the chart on kind (Kubernetes in Docker). A script builds images, loads them, deploys local stand-ins for RDS, S3 and SQS, and installs the release.",
      "Everything that differs from AWS is in values-kind.yaml. The app has no local mode: it always uses the S3 and SQS APIs through the AWS SDK.",
    ],
    why: ["The whole stack can be created and destroyed in minutes for free.", "Moving to EKS should be a new values file plus Terraform, with no app changes."],
    rejected: [{ option: "Going straight to EKS", reason: "Cost and setup before learning anything about the app on Kubernetes." }],
    costs: [
      "kind could not prove IAM, the load balancer, TLS or DNS. Those were proven on 2026-10-07 when the same chart went to EKS with one values file (ADR 0014), and the cluster was retired the same day for cost (ADR 0015).",
    ],
    oneLine:
      "I verified everything on a local kind cluster first; the same chart later ran on EKS for a day, which proved the AWS-only pieces, and kind stays the free daily demo.",
  },
  {
    adr: "0006",
    title: "One composition for preview and export; edits as a document",
    problem:
      "A phone preview and a server render usually drift apart (text wrapping, filters, timing). The edit also has to be stored, saved and undone safely.",
    decision: [
      "One React component, ReelComposition, draws a reel. The editor shows it with Remotion's Player; the worker renders the same component in headless Chrome.",
      "Fonts ship with the bundle, filters are CSS, motion is frame-based, so the export matches the preview. Only video decoding differs (<video> on phones, WebCodecs in the worker).",
      "The edit is a zod-validated JSON timeline changed only by pure functions: undo/redo as snapshots, autosave guarded by a revision number, unit tests without a browser.",
      "Export freezes the document into the job, so later edits don't change that video and a retry renders the same thing.",
      "Instagram rules (3 s to 3 min, caption limits, safe zones) live in one module, checked in the editor and again on the server.",
    ],
    why: ["What you see is what you export.", "Every editing rule is a pure, testable function."],
    rejected: [
      { option: "In-browser export", reason: "Slow and unreliable on mid-range phones, stops when the screen locks, no job to retry." },
      { option: "FFmpeg filter graphs with a separate canvas preview", reason: "Every visual feature written twice and kept in step." },
      { option: "Event-sourced operations", reason: "Much more machinery than a one-editor-per-reel app needs." },
    ],
    costs: [
      "Remotion needs a company licence above three people.",
      "The worker image is large (Chrome + compositor, ~1.5 GB).",
      "Signed media URLs last an hour; long sessions need a reload.",
      "No concurrent editing; the revision check deliberately refuses conflicting saves.",
    ],
    oneLine:
      "Preview and export use the same React component, so the video always matches the screen, and the edit is a JSON document changed by pure functions, which makes undo, autosave and tests simple.",
  },
  {
    adr: "0007",
    title: "Splat flythroughs rendered offline (experimental)",
    problem: "A 360 photo can only turn on the spot; a flythrough needs a 3D model of the room.",
    decision: [
      "Gaussian splatting (nerfstudio splatfacto) runs offline on a GPU as a script, outside the app.",
      "It renders a 1080×1920 MP4 along a smoothed camera path, which is imported as an ordinary video clip.",
    ],
    why: ["Best picture quality; the editor needs no 3D code because the result is just video."],
    rejected: [
      { option: "Depth from one 360 photo", reason: "The camera can only move about half a metre before holes appear." },
      { option: "Box room from the floor plan", reason: "Furniture painted flat on the walls." },
    ],
    costs: ["Needs a dedicated capture (100+ photos) and a GPU; experimental, not part of the deployed stack."],
    oneLine: "The heavy 3D work runs offline on a GPU and comes back as plain video, so the editor stays simple.",
  },
  {
    adr: "0008",
    title: "Walking between 360 photos",
    problem: "A tour of 360 photos joined by fades reads as a slideshow; the goal is one continuous camera move.",
    decision: [
      "Project each 360 photo onto its room's shape (outline, camera and ceiling height from the floor plan).",
      "A 'walk' transition moves the camera from the previous photo to the next through the doorways, blending both projections; the first frame matches the previous clip, so there is no cut.",
      "Route and motion are pure functions in packages/core/src/walk.ts, shared by the renderer, the plan overlay and the tests.",
    ],
    why: ["Works with the one or two photos per room that agents already have."],
    rejected: [{ option: "Gaussian splatting for every tour", reason: "Needs far more photos per room than a normal tour has." }],
    costs: ["Looks like Street View between photo positions; furniture is flat on the room shell."],
    oneLine: "I project each 360 photo onto its room so the camera can walk between photos in one continuous move, using only the photos agents already have.",
  },
  {
    adr: "0009",
    title: "Whole-home splat from 360 photos (experimental)",
    problem: "A real 3D splat of a home from only one or two 360 photos per room, which have almost no overlap.",
    decision: [
      "Cut each 360 photo into ordinary views with exact poses, estimate depth with a model, fit it to the known room shapes, and seed a splat with those points.",
      "Train with positions frozen so the splat can't invent geometry, then film it along the same route as the 360 walk.",
    ],
    why: ["Real depth inside rooms from existing tour photos."],
    rejected: [{ option: "Training a splat freely", reason: "It fills the unseen space between photos with floating blobs." }],
    costs: ["Smears at doorways and softer than the 360 walk; experimental research tooling, not production."],
    oneLine: "An experiment: I supply depth from a model and the floor plan so a splat can be trained from very few photos.",
  },
  {
    adr: "0010",
    title: "Transactional outbox for render queue messages",
    problem:
      "Queuing a render writes to two systems, a job row in Postgres and a message in SQS, and they cannot share a transaction. If the web process died between the commit and the send, the job stayed QUEUED with no message.",
    decision: [
      "The message is written to an OutboxMessage table in the same transaction as the job (new job or manual retry), so they commit together or not at all.",
      "A relay sends pending rows: lock one with SELECT ... FOR UPDATE SKIP LOCKED, send it to SQS, delete it. A failed send leaves the row and retries with backoff (1 s, 2 s, 4 s, up to 60 s).",
      "The web app runs the relay right after the commit, so renders start as fast as before; every worker also runs it every 5 s to send what the web app could not.",
    ],
    why: [
      "A committed job always gets its message, even if the web process dies or the queue is down.",
      "SKIP LOCKED lets every web and worker process relay at once without sending the same row twice.",
    ],
    rejected: [
      { option: "Send first, then insert the job", reason: "A worker could receive a message for a job that does not exist yet, or never will." },
      { option: "Change data capture (Debezium)", reason: "The standard answer at scale, but a whole extra system for a few messages a minute." },
      { option: "A separate relay deployment", reason: "One more thing to deploy and monitor; the worker already has both connections." },
    ],
    costs: [
      "The relay can send a message twice (crash after the send, before the delete commits). The worker is already idempotent, so that is harmless.",
      "While the queue is down a job waits in QUEUED instead of failing straight away.",
      "A row lock is held during the SQS call, so the call is limited to 10 s.",
    ],
    oneLine:
      "The job and its queue message are written in one database transaction and the message is sent afterwards, so a job can never be saved without its message; duplicates are fine because the worker is idempotent.",
  },
  {
    adr: "0011",
    title: "Terraform owns the AWS account",
    problem:
      "When the AWS account came back from a suspension it had a hand-made media bucket and a disabled CloudFront distribution, and nothing else the app needed: no queue, no image registry, no CI identity, no runtime identity, no spending limit.",
    decision: [
      "Every AWS resource ReelWalk uses is in infra/terraform, with state in a versioned S3 bucket and S3 lock files (no DynamoDB table).",
      "The two resources that already existed were imported, not recreated, so the CloudFront domain stayed the same.",
      "A GitHub OIDC provider and a role that only the main branch of the repository can assume, limited to pushing two ECR repositories. CI holds no AWS keys.",
      "An application IAM policy (objects in the bucket, the two queues) that every runtime reuses: an IAM user locally, Pod Identity on EKS, task and instance roles on Fargate and App Runner.",
      "A monthly budget with email alerts; scanner findings about a WAF and customer-managed keys accepted as cost decisions, with reasons in .trivyignore.yaml.",
    ],
    why: ["terraform plan is the drift check; nothing is changed in the console.", "Importing kept the domain and avoided re-uploading media."],
    rejected: [
      { option: "Click it together in the console", reason: "No history, no review, no way to rebuild it." },
      { option: "Stored access keys in GitHub secrets", reason: "OIDC gives short-lived credentials scoped to one branch and two repositories." },
    ],
    costs: ["Imported resources need their exact settings written down before plan is clean.", "The IAM user is a stop-gap for local runs against real AWS."],
    oneLine: "I put the whole AWS account under Terraform, importing what already existed, and gave CI an OIDC role instead of keys.",
  },
  {
    adr: "0012",
    title: "Accounts with passwords and database sessions",
    problem: "Every request acted as one seeded demo user. To hand the app to anyone else it needed sign-up, sign-in and separation between studios, without an email provider or OAuth app existing yet.",
    decision: [
      "Email and password, hashed with scrypt from Node's crypto (no native dependency), parameters stored with the hash.",
      "Sessions in Postgres: the browser holds a random token in an httpOnly cookie; the table stores only its SHA-256.",
      "One gate: getCurrentUser() resolves the session or redirects to /login, and a proxy does a cheap cookie check first. Every query is scoped to the user's workspace.",
      "The open starter library is flagged shared and visible to every workspace; uploads stay private.",
    ],
    why: ["Works over plain HTTP on a phone on the home network.", "Adding magic links or Google sign-in later is another way to call createSession(), not a new model."],
    rejected: [
      { option: "A hosted auth provider", reason: "Another account and callback to set up before anyone could log in; fine later, not for the first version." },
      { option: "JWTs in the cookie", reason: "Cannot be revoked; a database row can." },
    ],
    costs: ["No password reset until there is an email provider.", "One user per workspace: no teams yet."],
    oneLine: "Email and password with scrypt, sessions as database rows behind an httpOnly cookie, and one function that scopes every query to the signed-in workspace.",
  },
  {
    adr: "0013",
    title: "Venue reels, stock footage and share links",
    problem: "The editor and the tour auto-build were built for listings. A restaurant's menu is already a shot list, but most venues have no footage, and sharing a file from the share sheet only works over HTTPS.",
    decision: [
      "Venue vibes: a complete treatment (song, look, cut length, hook, label style, call to action, caption). buildVenueReel() turns tapped clips, dishes and prices into a timeline cut on the beat, one dish label per clip, the details card closing with price, address and handle.",
      "Free stock footage from Pixabay, searched server-side; imports keep the source, licence and creator credit, and the credit joins the caption.",
      "A public share page per reel, /r/<token>, with the latest export, the caption and a Save button. No sign-in; turning the link off deletes the token.",
    ],
    why: ["The render composition is reused unchanged: the details card shows 'from $12' where a listing shows the price.", "A link works from any phone and messenger, HTTPS or not."],
    rejected: [{ option: "A separate restaurant product", reason: "Same timeline, same renderer, same queue; only the builder differs." }],
    costs: ["A share link exposes the export to anyone holding it; links are long, random and revocable.", "Stock clips are stored per workspace."],
    oneLine: "I generalised the tour builder into venue reels with dish labels and stock footage, and added a public share link because the share sheet needs HTTPS.",
  },
  {
    adr: "0014",
    title: "Production on EKS and RDS (superseded the same day)",
    problem: "Share links, the Instagram OAuth callback and the videos Instagram fetches all need a public HTTPS address; the chart had only run on kind.",
    decision: [
      "A VPC in two zones with nodes in public subnets and no NAT gateway (it costs more than the database), the database in private subnets.",
      "EKS 1.34 with one t3.xlarge node group; pods get AWS access through EKS Pod Identity, so the cluster Secret holds no keys.",
      "RDS Postgres 16 on the smallest Graviton class, reachable only from the node security group.",
      "ingress-nginx behind a network load balancer, cert-manager with Let's Encrypt, Cloudflare DNS at the apex.",
    ],
    why: ["It proved the chart on a real cluster: IAM, load balancer, TLS and DNS, with a real render verified end to end at reelwalking.com."],
    rejected: [{ option: "A single VM with Compose", reason: "Would have been cheaper; the user chose EKS to exercise Kubernetes on AWS." }],
    costs: [
      "About $250 a month: $73 control plane, $120 node, $17 load balancer, $15 database, almost all of it idle. Retired after one day (ADR 0015).",
      "Three small surprises worth remembering: RDS 16 forces TLS (sslmode), Terraform output on Windows carries a carriage return, and a changed external Secret does not roll pods by itself.",
    ],
    oneLine: "I ran production on EKS and RDS for a day, which proved the chart end to end, and took it down because the bill was for idle hardware.",
  },
  {
    adr: "0015",
    title: "Production for under $30 a month",
    problem: "EKS was the wrong shape for an app with one studio and a render every now and then: a quarter of the bill was the control plane and half was an idle node.",
    decision: [
      "Web app on AWS App Runner (0.5 vCPU, 1 GB) from the same ECR image; HTTPS, custom domain and certificate come with the service, so no load balancer, ingress or cert-manager.",
      "Render workers as Fargate tasks started on demand: when an export is queued the web app calls ecs:RunTask (capped by ECS_MAX_WORKERS), the task drains the queue and exits after four idle minutes. Nothing bills between renders.",
      "Postgres on a free tier outside AWS; settings and credentials in SSM Parameter Store; task and instance roles instead of keys.",
      "The VPC stays for the tasks; EKS, the node group, RDS and the pod-identity role are removed.",
    ],
    why: ["Expected run rate $10-15 a month, idle cost about $5.", "The queue, outbox, heartbeat lease and dead-letter handling are unchanged; only who starts the worker changed."],
    rejected: [
      { option: "Keep EKS on a smaller or spot node", reason: "The $73 control plane and $17 load balancer are the floor; still over $100." },
      { option: "Remotion Lambda", reason: "Near-zero idle cost and the real long-term answer, but it replaces the worker and needs the WebGL transitions tested under Lambda; a separate project." },
    ],
    costs: [
      "The first export after a quiet spell waits one to two minutes for a cold task (image pull, Chrome start).",
      "If a worker exits at the same moment a message arrives, that message waits for the next export; a scheduled check could close the gap.",
    ],
    oneLine: "I moved the web app to App Runner and made the render worker a Fargate task the web app starts on demand, cutting the bill from about $250 to about $15 a month with the same images and queue.",
  },
];
