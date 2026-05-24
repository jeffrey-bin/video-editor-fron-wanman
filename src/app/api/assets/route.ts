import { NextResponse } from "next/server";
import { addAssetToProject } from "@/server/state/persistent";

export async function POST(request: Request) {
  const form = await request.formData();
  const projectId = String(form.get("projectId") ?? "project_demo");
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "MISSING_FILE" }, { status: 400 });
  const asset = await addAssetToProject(projectId, { name: file.name, type: file.type, size: file.size, bytes: await file.arrayBuffer() });
  return NextResponse.json({ asset, jobId: `asset_ingest_${asset.id}` });
}
