import { NextResponse } from "next/server";
import { applyPendingPlan } from "@/server/state/persistent";

export async function POST(request: Request, context: { params: Promise<{ projectId: string }> }) {
  try {
    const { projectId } = await context.params;
    const body = await request.json();
    return NextResponse.json(await applyPendingPlan(projectId, body));
  } catch (error) {
    if (error instanceof Error && error.name === "TIMELINE_VERSION_CONFLICT") {
      return NextResponse.json({ error: { code: "TIMELINE_VERSION_CONFLICT", message: "时间线版本已变化，请重新生成方案。" } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "APPLY_PLAN_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
