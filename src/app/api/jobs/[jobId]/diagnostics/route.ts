import { NextResponse } from "next/server";
import { requireOpsAuth } from "@/server/observability/auth";
import { listJobDiagnostics } from "@/server/observability/diagnostics";
import { getJob } from "@/server/state/persistent";

export async function GET(request: Request, context: { params: Promise<{ jobId: string }> }) {
  const denied = requireOpsAuth(request);
  if (denied) return denied;
  const { jobId } = await context.params;
  const job = await getJob(jobId);
  if (!job) return NextResponse.json({ error: "JOB_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ job: { id: job.id, type: job.type, status: job.status, attempts: job.attempts, max_attempts: job.maxAttempts, error: job.error }, diagnostics: await listJobDiagnostics(jobId) });
}
