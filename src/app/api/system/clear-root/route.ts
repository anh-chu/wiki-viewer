import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { writeConfig } from "@/lib/config";
import { clearRootDir } from "@/lib/root-dir";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	clearRootDir();
	await writeConfig({ lastOpenedPath: undefined });
	return NextResponse.json({ ok: true });
}
