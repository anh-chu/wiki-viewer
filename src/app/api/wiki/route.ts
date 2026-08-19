import { readdir, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { isAppFolder, isNodeApp } from "@/lib/wiki-helpers";
import { detectGitRepo } from "@/lib/git";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const { searchParams } = new URL(request.url);
	const dir = searchParams.get("dir") ?? "";

	const dirRes = await resolveWorkspacePath(rootDir, dir, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!dirRes)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	const targetDir = dirRes.absolutePath;

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
				if (!info.isDirectory()) {
					return {
						name,
						type: "file" as const,
						size: info.size,
						modifiedAt: info.mtime.toISOString(),
					};
				}

				const relPath = dir ? `${dir}/${name}` : name;
				const nodeApp = await isNodeApp(rootDir, relPath);
				const isApp = nodeApp ? false : await isAppFolder(rootDir, relPath);
				const type = nodeApp ? "node-app" as const : (isApp ? "app" as const : "dir" as const);

				const entry: {
					name: string;
					type: "node-app" | "app" | "dir";
					modifiedAt: string;
					git?: { branch: string; dirty: boolean };
				} = {
					name,
					type,
					modifiedAt: info.mtime.toISOString(),
				};

				const gitInfo = await detectGitRepo(filePath);
				if (gitInfo) entry.git = gitInfo;
				return entry;
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
	const ctx = await resolveWorkspaceForUser(request, "write");
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });
	const { rootDir } = ctx;

	const body: { path?: string } = await request.json();
	const rel = body.path;
	if (!rel || typeof rel !== "string")
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	const fileRes = await resolveWorkspacePath(rootDir, rel, {
		deniedSegments: DENIED_SEGMENTS,
	});
	if (!fileRes || fileRes.absolutePath === rootDir)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });
	const filePath = fileRes.absolutePath;

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
