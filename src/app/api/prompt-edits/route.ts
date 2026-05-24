import { NextResponse } from "next/server";
import { createPromptEditJob } from "@/server/state/persistent";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const result = await createPromptEditJob({
      project_id: body.project_id,
      timeline_version: body.timeline_version,
      prompt: body.prompt,
      locale: body.locale,
      scope: body.scope,
    });
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: { code: "PROMPT_EDIT_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
