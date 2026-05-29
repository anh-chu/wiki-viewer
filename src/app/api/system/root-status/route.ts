import { NextResponse } from "next/server";
import { getRootDir, isRootDirSet } from "@/lib/root-dir";

export async function GET() {
	return NextResponse.json({
		configured: isRootDirSet(),
		path: isRootDirSet() ? getRootDir() : null,
	});
}
