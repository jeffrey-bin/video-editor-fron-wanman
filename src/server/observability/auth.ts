import { NextResponse } from "next/server";

export const requireOpsAuth = (request: Request) => {
  if (process.env.NODE_ENV !== "production") return null;
  const expected = process.env.OBSERVABILITY_TOKEN;
  if (!expected) return NextResponse.json({ error: "OBSERVABILITY_TOKEN_REQUIRED" }, { status: 503 });
  const header = request.headers.get("authorization") ?? "";
  if (header !== `Bearer ${expected}`) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
  return null;
};
