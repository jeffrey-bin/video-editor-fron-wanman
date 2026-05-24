import { NextResponse } from "next/server";
import { getRunnerInfo } from "@/server/workers/heartbeat";

export async function GET() {
  return NextResponse.json({ status: "live", ...getRunnerInfo() });
}
