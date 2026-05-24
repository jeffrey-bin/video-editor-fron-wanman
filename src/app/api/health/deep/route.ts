import { NextResponse } from "next/server";
import { requireOpsAuth } from "@/server/observability/auth";
import { collectDeepHealth } from "@/server/observability/health";

export async function GET(request: Request) {
  const denied = requireOpsAuth(request);
  if (denied) return denied;
  const health = await collectDeepHealth();
  return NextResponse.json(health, { status: health.status === "not_ready" ? 503 : 200 });
}
