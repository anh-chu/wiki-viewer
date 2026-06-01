import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { getRootDir, safeRootPath } from "@/lib/root-dir";
import { isAppFolder, isNodeApp } from "@/lib/wiki-helpers";

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const { searchParams } = new URL(request.url);
	const dir = searchParams.get("dir") ?? "";

	const targetDir = safeRootPath(dir);
	if (!targetDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		let names: string[];
		try {
			names = await readdir(targetDir);
		} catch {
			return NextResponse.json({ entries: [] });
		}

		const entries = await Promise.all(
			names.map(async (name) => {
				const filePath = path.join(targetDir, name);
				const info = await stat(filePath);
				if (info.isDirectory()) {
					const relPath = dir ? `${dir}/${name}` : name;
					const nodeApp = await isNodeApp(getRootDir(), relPath);
					if (nodeApp) {
						return {
							name,
							type: "node-app" as const,
							modifiedAt: info.mtime.toISOString(),
						};
					}
					const isApp = await isAppFolder(getRootDir(), relPath);
					return {
						name,
						type: (isApp ? "app" : "dir") as "app" | "dir",
						modifiedAt: info.mtime.toISOString(),
					};
				}
				return {
					name,
					type: "file" as const,
					size: info.size,
					modifiedAt: info.mtime.toISOString(),
				};
			}),
		);

		entries.sort((a, b) => {
			const aIsDir = a.type === "dir" || a.type === "app" || a.type === "node-app";
			const bIsDir = b.type === "dir" || b.type === "app" || b.type === "node-app";
			if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
			return a.name.localeCompare(b.name);
		});

		return NextResponse.json({ entries });
	} catch {
		return NextResponse.json(
			{ error: "Failed to list directory" },
			{ status: 500 },
		);
	}
}

export async function DELETE(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const filePath = safeRootPath(rel);
	if (!filePath || filePath === getRootDir())
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		const info = await stat(filePath);
		if (info.isDirectory()) {
			await rmdir(filePath);
		} else {
			await unlink(filePath);
		}
		return NextResponse.json({ ok: true });
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT")
			return NextResponse.json({ error: "Not found" }, { status: 404 });
		if (code === "ENOTEMPTY")
			return NextResponse.json(
				{ error: "Folder is not empty" },
				{ status: 409 },
			);
		return NextResponse.json({ error: "Delete failed" }, { status: 500 });
	}
}
