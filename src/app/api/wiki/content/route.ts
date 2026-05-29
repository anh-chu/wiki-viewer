import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { safeRootPath } from "@/lib/root-dir";

const TEXT_EXTS = new Set([
	"txt", "md", "markdown", "json", "yaml", "yml", "toml", "csv",
	"xml", "html", "css", "js", "ts", "tsx", "jsx", "sh", "bash",
	"zsh", "rb", "py", "go", "rs", "java", "c", "cpp", "h", "php",
	"swift", "kt", "lua", "sql", "scss",
]);
const MAX_EDIT_SIZE = 1 * 1024 * 1024; // 1MB

function isTextFile(filename: string): boolean {
	const ext = filename.split(".").pop()?.toLowerCase() ?? "";
	return TEXT_EXTS.has(ext);
}

export async function GET(request: Request) {
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
		return NextResponse.json({ content: buffer.toString("utf-8") });
	} catch {
		return NextResponse.json({ error: "File not found" }, { status: 404 });
	}
}

export async function PUT(request: Request) {
	const body: { path?: string; content?: string } = await request.json();
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
	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf-8");
		return NextResponse.json({ ok: true });
	} catch {
		return NextResponse.json({ error: "Failed to save" }, { status: 500 });
	}
}
