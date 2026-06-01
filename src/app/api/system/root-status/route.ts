import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { getRootDir, isRootDirSet } from "@/lib/root-dir";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	return NextResponse.json({
		configured: isRootDirSet(),
		path: isRootDirSet() ? getRootDir() : null,
	});
}
