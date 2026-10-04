// Liveness: the process is up. Deliberately touches nothing else, so a
// database outage does not make Kubernetes restart healthy web pods.
export function GET() {
  return Response.json({ ok: true });
}
