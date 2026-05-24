import { NextResponse } from "next/server";
import { collectReadyHealth } from "@/server/observability/health";

export async function GET() {
  const health = await collectReadyHealth();
  return NextResponse.json(health, { status: health.status === "not_ready" ? 503 : 200 });
}
