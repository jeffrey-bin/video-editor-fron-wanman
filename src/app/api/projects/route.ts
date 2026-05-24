import { NextResponse } from "next/server";
import { createDefaultProject, listAssets } from "@/server/state/in-memory";

export async function GET() {
  const project = createDefaultProject();
  return NextResponse.json({ project, assets: listAssets(project.id) });
}
