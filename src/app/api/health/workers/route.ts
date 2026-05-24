import { NextResponse } from "next/server";
import { requireOpsAuth } from "@/server/observability/auth";
import { listWorkerHeartbeats } from "@/server/workers/heartbeat";

export async function GET(request: Request) {
  const denied = requireOpsAuth(request);
  if (denied) return denied;
  return NextResponse.json(await listWorkerHeartbeats());
}
