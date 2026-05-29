import { NextResponse } from "next/server";
import { readConfig } from "@/lib/config";

export async function GET() {
	const config = await readConfig();
	return NextResponse.json({
		pinnedPaths: config.pinnedPaths ?? [],
		lastOpenedPath: config.lastOpenedPath ?? null,
	});
}
