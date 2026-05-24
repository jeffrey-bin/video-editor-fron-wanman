import { NextResponse } from "next/server";
import { applyPendingPlan } from "@/server/state/in-memory";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const body = await request.json();
    return NextResponse.json(applyPendingPlan(projectId, body));
  } catch (error) {
    return NextResponse.json({ error: { code: "APPLY_PLAN_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
