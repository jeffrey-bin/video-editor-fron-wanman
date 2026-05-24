import { NextResponse } from "next/server";
import { createDefaultProject, listAssets } from "@/server/state/persistent";

export async function GET() {
  const project = await createDefaultProject();
  return NextResponse.json({ project, assets: await listAssets(project.id) });
}
