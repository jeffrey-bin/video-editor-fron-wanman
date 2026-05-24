import { NextResponse } from "next/server";
import { requireOpsAuth } from "@/server/observability/auth";
import { collectQueueMetrics } from "@/server/observability/metrics";

export async function GET(request: Request) {
  const denied = requireOpsAuth(request);
  if (denied) return denied;
  return NextResponse.json(await collectQueueMetrics());
}
