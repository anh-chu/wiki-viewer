import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { emitEvents, trimEvents } from "@/lib/proof/event-bus";
import { withFileMutex } from "@/lib/proof/mutex";
import { emptySidecar, readSidecar, writeSidecar } from "@/lib/proof/sidecar";
import { SIDECAR_EVENT_TRIM_SIZE } from "@/lib/proof-config";
import { getRootDir, safeRootPath } from "@/lib/root-dir";

const TEXT_EXTS = new Set([
	"txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv",
	"xml", "html", "css", "js", "ts", "tsx", "jsx", "sh", "bash",
	"zsh", "rb", "py", "go", "rs", "java", "c", "cpp", "h", "php",
	"swift", "kt", "lua", "sql", "scss",
]);
const MARKDOWN_EXTS = new Set(["md", "markdown"]);
const MAX_EDIT_SIZE = 1 * 1024 * 1024; // 1MB

function isTextFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTS.has(ext);
}

function isMarkdownFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return MARKDOWN_EXTS.has(ext);
}

function sha256content(content: string): string {
	return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

export async function GET(request: Request) {
	const sessionAuth = await requireUser(request);
	if (!sessionAuth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	const filePath = safeRootPath(rel);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	if (!isTextFile(path.basename(filePath)))
		return NextResponse.json({ error: "Not a text file" }, { status: 400 });
	try {
		const buffer = await readFile(filePath);
		if (buffer.length > MAX_EDIT_SIZE)
			return NextResponse.json(
				{ error: "File too large (max 1MB)" },
				{ status: 413 },
			);
		const content = buffer.toString("utf-8");
		const headers: Record<string, string> = {};
		if (isMarkdownFile(path.basename(filePath))) {
			const rootDir = getRootDir();
			const sc = await readSidecar(rootDir, rel);
			if (sc) {
				headers["X-Wiki-Revision"] = String(sc.revision);
				headers["X-Wiki-Fingerprint"] = sc.fingerprint;
			}
		}
		return NextResponse.json({ content }, { headers });
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}

export async function PUT(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const user = await requireUser(request);
	if (!user.ok) {
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
	}

	const body: { path?: string; content?: string; baseRevision?: number } =
		await request.json();
	const rel = body.path;
	const content = body.content;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	if (typeof content !== "string")
		return NextResponse.json({ error: "Missing content" }, { status: 400 });
	const filePath = safeRootPath(rel);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	if (!isTextFile(path.basename(filePath)))
		return NextResponse.json({ error: "Not a text file" }, { status: 400 });

	// Non-markdown files: plain write, no revision tracking.
	if (!isMarkdownFile(path.basename(filePath))) {
		try {
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, content, "utf-8");
			return NextResponse.json({ ok: true });
		} catch {
			return NextResponse.json({ error: "Failed to save" }, { status: 500 });
		}
	}

	// Markdown files: mutex + sidecar revision check + fingerprint update + event.
	return withFileMutex(filePath, async () => {
		const rootDir = getRootDir();
		const sc = (await readSidecar(rootDir, rel)) ?? emptySidecar(rel);

		// baseRevision is required for markdown to prevent lost writes.
		if (body.baseRevision === undefined || typeof body.baseRevision !== "number") {
			return NextResponse.json(
				{ error: "BASE_REVISION_REQUIRED", message: "baseRevision is required when saving markdown files." },
				{ status: 400 },
			);
		}

		// Enforce staleness check.
		if (
			body.baseRevision !== sc.revision
		) {
			return NextResponse.json(
				{
					error: "STALE_REVISION",
					currentRevision: sc.revision,
					message: "File was modified since your last read. Reload and retry.",
				},
				{ status: 409 },
			);
		}

		try {
			await mkdir(path.dirname(filePath), { recursive: true });
			await writeFile(filePath, content, "utf-8");
		} catch {
			return NextResponse.json({ error: "Failed to save" }, { status: 500 });
		}

		// Update sidecar metadata.
		const newRevision = sc.revision + 1;
		sc.revision = newRevision;
		sc.fingerprint = sha256content(content);
		sc.updatedAt = new Date().toISOString();

		// Emit a human-edit event so agents can see the change.
		emitEvents(sc, [
			{
				type: "file.edited",
				at: new Date().toISOString(),
				by: `user:${user.user.id}`,
				revision: newRevision,
			},
		]);
		trimEvents(sc, SIDECAR_EVENT_TRIM_SIZE);

		await writeSidecar(rootDir, rel, sc);

		return NextResponse.json({ ok: true, revision: newRevision });
	});
}
