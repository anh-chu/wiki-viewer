export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET(_req: NextRequest): Promise<NextResponse> {
	const skillPath = path.resolve(
		process.cwd(),
		"agents/wiki-viewer-skill/SKILL.md"
	);
	const content = await readFile(skillPath, "utf-8");
	return new NextResponse(content, {
		status: 200,
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
