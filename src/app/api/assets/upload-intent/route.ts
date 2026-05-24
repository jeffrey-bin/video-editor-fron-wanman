import { NextResponse } from "next/server";
import { createAssetUploadIntent } from "@/server/state/persistent";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const intent = await createAssetUploadIntent({
      project_id: body.project_id,
      file_name: body.file_name,
      mime_type: body.mime_type,
      size_bytes: body.size_bytes,
      sha256: body.sha256,
    });
    return NextResponse.json(intent);
  } catch (error) {
    return NextResponse.json({ error: { code: "UPLOAD_INTENT_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
