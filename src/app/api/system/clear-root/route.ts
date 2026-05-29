import { NextResponse } from "next/server";
import { writeConfig } from "@/lib/config";
import { clearRootDir } from "@/lib/root-dir";

export async function POST() {
	clearRootDir();
	await writeConfig({ lastOpenedPath: undefined });
	return NextResponse.json({ ok: true });
}
