import { requireOpsAuth } from "@/server/observability/auth";
import { renderPrometheusMetrics } from "@/server/observability/metrics";

export async function GET(request: Request) {
  const denied = requireOpsAuth(request);
  if (denied) return denied;
  return new Response(await renderPrometheusMetrics(), {
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
  });
}
