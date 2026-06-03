import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import JSZip from "jszip";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";
import { safeRootPath } from "@/lib/root-dir";

// Skip noise that should never end up in a downloaded archive.
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".proof"]);

function contentDisposition(filename: string): string {
	// RFC 5987: ASCII fallback + UTF-8 encoded form for non-ASCII names.
	const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "'");
	const encoded = encodeURIComponent(filename);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

async function addDirToZip(
	zip: JSZip,
	absDir: string,
	zipPrefix: string,
): Promise<void> {
	const names = await readdir(absDir);
	for (const name of names) {
		if (SKIP_DIRS.has(name)) continue;
		const abs = path.join(absDir, name);
		const info = await stat(abs);
		const zipPath = zipPrefix ? `${zipPrefix}/${name}` : name;
		if (info.isDirectory()) {
			await addDirToZip(zip, abs, zipPath);
		} else if (info.isFile()) {
			zip.file(zipPath, await readFile(abs));
		}
	}
}

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const { searchParams } = new URL(request.url);
	const rel = searchParams.get("path") ?? "";
	const target = safeRootPath(rel);
	if (!target)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(target);
	} catch {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	const baseName = path.basename(target) || "download";

	if (info.isFile()) {
		const webStream = Readable.toWeb(
			createReadStream(target),
		) as ReadableStream;
		return new Response(webStream, {
			headers: {
				"Content-Type": "application/octet-stream",
				"Content-Length": String(info.size),
				"Content-Disposition": contentDisposition(baseName),
				"Cache-Control": "private, no-store",
			},
		});
	}

	if (info.isDirectory()) {
		const zip = new JSZip();
		try {
			await addDirToZip(zip, target, "");
		} catch {
			return NextResponse.json(
				{ error: "Failed to read folder" },
				{ status: 500 },
			);
		}
		const buffer = await zip.generateAsync({
			type: "nodebuffer",
			compression: "DEFLATE",
			compressionOptions: { level: 6 },
		});
		return new Response(new Uint8Array(buffer), {
			headers: {
				"Content-Type": "application/zip",
				"Content-Length": String(buffer.length),
				"Content-Disposition": contentDisposition(`${baseName}.zip`),
				"Cache-Control": "private, no-store",
			},
		});
	}

	return NextResponse.json({ error: "Unsupported path" }, { status: 400 });
}
