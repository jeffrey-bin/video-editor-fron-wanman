import { NextResponse } from "next/server";
import { getJob } from "@/server/state/in-memory";

export async function GET(_request: Request, context: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await context.params;
  const job = getJob(jobId);
  if (!job) return NextResponse.json({ error: "JOB_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ job });
}
