import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { readConfig } from "@/lib/config";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const config = await readConfig();
	return NextResponse.json({
		pinnedPaths: config.pinnedPaths ?? [],
		lastOpenedPath: config.lastOpenedPath ?? null,
	});
}
