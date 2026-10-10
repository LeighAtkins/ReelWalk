# Kubernetes notes: what the chart does and what testing it taught me

The Helm chart in `infra/helm/reelwalk` deploys ReelWalk to the local kind
cluster, where Argo CD keeps it in step with `main`. Production moved to App
Runner and Fargate for cost (ADR 0015), so this is where the Kubernetes side
of the project lives. These notes cover the parts the CKAD exam also covers,
and what happened when I tested each one, rather than what the docs promise.

## What runs

| Object | Why |
| --- | --- |
| `Deployment` web (2 pods) | The Next.js app. `maxUnavailable: 0` so a rollout never drops below two. |
| `Deployment` worker | Pulls render jobs from SQS (ElasticMQ in kind). Takes no traffic. |
| `Job` migrate | `prisma migrate deploy` and the seed, as an Argo CD sync wave before the Deployments. Its name carries a hash of the image tag, because a Job's pod template is immutable. |
| `Service` web | NodePort 30080 in kind, mapped to `localhost:8081`. |
| `ConfigMap` and `Secret` | Settings and credentials, injected with `envFrom`. A checksum annotation rolls the pods when either changes. |
| `HorizontalPodAutoscaler` web and worker | CPU-based. On for web in kind. |
| `PodDisruptionBudget` web | Keeps one web pod up while a node is drained. |
| 3 `NetworkPolicy` objects | Deny by default, then allow what each pod needs. |

## Probes: readiness and liveness ask different questions

- **Readiness** (`/api/ready`): can this pod serve? It checks the database. A
  failing pod stays running but leaves the Service until it recovers.
- **Liveness** (`/api/health`): is the process alive at all? It checks nothing
  outside the pod.

The split matters. If liveness also checked the database, a database outage
would restart every web pod in a loop and make the outage worse. The worker
has only a liveness probe (`/healthz` on 8081), because nothing sends it
traffic.

## Resources, and what the autoscaler measured

Requests are what the scheduler reserves; limits are the ceiling. The chart
sets a memory limit but no CPU limit, on purpose: a CPU limit throttles a
render in the middle of a frame, while going over a memory limit kills the pod
(OOMKilled), which is the signal I want. The render worker taught that the
hard way on Fargate: the compositor sized its cache from the host's memory, not
the container's limit, and was killed.

**Load test (2026-10-10).** I ran three pods that called `/api/ready` in a
loop and watched the web autoscaler:

```
before:      cpu: 2%/70%    replicas 2
+20 s:       cpu: 525%/70%  replicas 2 -> 4 (the maximum)
under load:  cpu: 300-400%/70%  replicas 4
```

What that showed:

- **Utilization is a percentage of `requests.cpu`, not of a core.** 525% of
  100m is about half a core per pod. A request set far below real usage makes
  the autoscaler react to almost any traffic. For a real deployment, `requests`
  should come from measured usage (`kubectl top pods` under normal load).
- **Without metrics-server the autoscaler does nothing.** The target stays
  `<unknown>`. kind does not ship it; `infra/kind/metrics-server.sh` installs it
  (with `--kubelet-insecure-tls`, which is only acceptable on a local cluster).
- **Removing `replicas` from a Deployment once an autoscaler owns it resets it
  to 1** for a moment, because applying a manifest without the field falls back
  to the default. The autoscaler then raises it back to `minReplicas`. The chart
  leaves `replicas` out when autoscaling is on, so Argo CD and the autoscaler
  do not fight over it.
- **Scale-down is slow on purpose.** `behavior.scaleDown.stabilizationWindowSeconds: 300`
  waits five minutes of low usage before removing pods, so traffic that comes in
  waves does not make pods come and go.

## NetworkPolicy: deny by default, and test it

Policies add up. A pod may send or receive whatever *any* policy selecting it
allows, and once one policy selects a pod for a direction, everything else in
that direction is denied. The chart has three:

1. `default-deny`: selects every pod of the release, with no rules, for both
   Ingress and Egress.
2. `web-ingress`: web pods accept TCP 3000. Workers and the migrate Job get no
   ingress rule, so nothing can connect to them.
3. `egress`: DNS to CoreDNS in `kube-system`, the in-cluster dependencies by
   label (Postgres, MinIO, ElasticMQ in kind), and `0.0.0.0/0` except blocked
   ranges, for S3, SQS, the database and Instagram.

Blocking `169.254.169.254` (the cloud metadata address) matters beyond kind: if
the app were tricked into fetching a URL (SSRF), it still could not read the
node's cloud credentials.

**Tested on kind, before and after, with Argo CD pointed at the branch:**

| From -> to | No policies | First version | Final version |
| --- | --- | --- | --- |
| Pod outside the app -> web :3000 | open | open | open |
| Pod outside the app -> worker :8081 | open | **blocked** | **blocked** |
| web -> Argo CD server (other namespace) | open | **open** | **blocked** |
| web -> Postgres | open | open | open |
| web -> the internet | open | open | open |
| worker -> ElasticMQ | open | open | open |

The first version had a hole: **`ipBlock: 0.0.0.0/0` also matched pod
addresses**, so "the internet" included every pod in the cluster. The
Kubernetes docs say `ipBlock` is meant for addresses outside the cluster and
leave pod addresses implementation-defined; kindnet matches them. The fix was
to add kind's pod and Service ranges (`10.244.0.0/16`, `10.96.0.0/16`) to the
blocked list. The dependencies stay reachable because they have their own
`podSelector` rules, and rules are OR-ed.

Other things the test showed:

- **The kubelet's probes still reach the worker** with no ingress rule. kindnet
  allows traffic from the node itself; not every CNI does, so check this when
  changing CNI.
- **A NetworkPolicy does nothing unless the CNI enforces it.** kindnet does
  since kind 0.24, and Calico and Cilium do. The AWS VPC CNI only does when its
  network policy agent is turned on.
- **Argo CD with `prune` and `selfHeal` undoes manual `kubectl apply`.** To test
  a chart change for real, I pointed the Application's `targetRevision` at the
  branch, let it sync, and pointed it back at `main` afterwards.

## Security context

Every container runs as UID 1000 with a read-only root filesystem, no
privilege escalation, all Linux capabilities dropped and the RuntimeDefault
seccomp profile. Anything that has to write gets an `emptyDir`: `/tmp`
(`HOME` points there for Prisma, Chrome and tsx), the Next.js cache, and a
memory-backed `/dev/shm` for Chrome, which needs more than the default 64 MB.

## CKAD topics this does not cover yet

Practised here: Deployments and rollouts, probes, resources, ConfigMaps and
Secrets, Jobs, Services, NetworkPolicies, the HPA, security contexts and Helm.

Still to practise for the exam: CronJobs, multi-container pods (sidecars and
init containers), PersistentVolumeClaims beyond Postgres's, Ingress rules by
hand, `kubectl` imperative speed (`run`, `create`, `expose`, `--dry-run=client
-o yaml`), resource quotas and LimitRanges, and debugging (`describe`, `logs
--previous`, `exec`, events).
