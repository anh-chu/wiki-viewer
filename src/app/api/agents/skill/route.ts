export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { SKILL_MD } from "@/lib/agents/skill-md";

export async function GET(_req: NextRequest): Promise<NextResponse> {
	return new NextResponse(SKILL_MD, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
