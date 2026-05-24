import { NextResponse } from "next/server";
import { getExportDownloadUrl } from "@/server/state/persistent";

export async function GET(_request: Request, context: { params: Promise<{ exportId: string }> }) {
  try {
    const { exportId } = await context.params;
    return NextResponse.json(await getExportDownloadUrl(exportId));
  } catch {
    return NextResponse.json({ error: { code: "EXPORT_NOT_FOUND", message: "导出文件不存在或已过期。" } }, { status: 404 });
  }
}
