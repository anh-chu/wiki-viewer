import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { safeWorkspacePath } from "@/lib/workspaces";

const MAX_PDF_BYTES = 50 * 1024 * 1024; // 50MB

// Overwrites a PDF in place with annotation-baked bytes from the browser viewer.
// Body = raw application/pdf. Path via ?path= query (workspace-relative).
export async function PUT(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const rel = new URL(request.url).searchParams.get("path");
	if (!rel) return NextResponse.json({ error: "Missing path" }, { status: 400 });
	if (path.extname(rel).toLowerCase() !== ".pdf")
		return NextResponse.json({ error: "Not a PDF" }, { status: 400 });

	const filePath = safeWorkspacePath(rootDir, rel);
	if (!filePath) return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const buf = Buffer.from(await request.arrayBuffer());
	if (buf.length === 0)
		return NextResponse.json({ error: "Empty body" }, { status: 400 });
	if (buf.length > MAX_PDF_BYTES)
		return NextResponse.json({ error: "PDF exceeds 50MB limit" }, { status: 413 });
	// ponytail: cheap %PDF magic check, not a full parse. Add structural validation if corrupt writes appear.
	if (buf.subarray(0, 5).toString("latin1") !== "%PDF-")
		return NextResponse.json({ error: "Not a valid PDF" }, { status: 400 });

	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, buf);
		return NextResponse.json({ ok: true, size: buf.length });
	} catch {
		return NextResponse.json({ error: "Failed to save" }, { status: 500 });
	}
}
