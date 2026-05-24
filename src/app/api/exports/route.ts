import { NextResponse } from "next/server";
import { createExportJob } from "@/server/state/persistent";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    return NextResponse.json(await createExportJob({ project_id: body.project_id, preset: body.preset ?? "1080p_landscape", timeline_version: body.timeline_version, ignorePendingPlan: body.ignorePendingPlan }));
  } catch (error) {
    if (error instanceof Error && error.name === "UNCONFIRMED_EDIT_PLAN") {
      return NextResponse.json({ error: { code: "UNCONFIRMED_EDIT_PLAN", message: "存在未确认 AI 方案。" } }, { status: 409 });
    }
    if (error instanceof Error && error.name === "TIMELINE_VERSION_CONFLICT") {
      return NextResponse.json({ error: { code: "TIMELINE_VERSION_CONFLICT", message: "时间线版本已变化，请刷新后重试。" } }, { status: 409 });
    }
    return NextResponse.json({ error: { code: "EXPORT_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
