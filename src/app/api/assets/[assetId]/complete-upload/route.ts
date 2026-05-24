import { NextResponse } from "next/server";
import { completeAssetUpload } from "@/server/state/persistent";

export async function POST(request: Request, context: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await context.params;
    const body = await request.json();
    return NextResponse.json(await completeAssetUpload(assetId, { project_id: body.project_id, object_key: body.object_key, sha256: body.sha256 }));
  } catch (error) {
    return NextResponse.json({ error: { code: "COMPLETE_UPLOAD_FAILED", message: error instanceof Error ? error.message : "未知错误" } }, { status: 400 });
  }
}
