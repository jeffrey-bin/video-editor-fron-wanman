import { NextResponse } from "next/server";
import { createExportJob } from "@/server/state/in-memory";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(createExportJob({ project_id: body.project_id, preset: body.preset ?? "1080p_landscape", ignorePendingPlan: body.ignorePendingPlan }));
  } catch (error) {
    if (error instanceof Error && error.name === "UNCONFIRMED_EDIT_PLAN") {
      return NextResponse.json({ error: { code: "UNCONFIRMED_EDIT_PLAN", message: "存在未确认 AI 方案。" } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "EXPORT_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
