import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/server";

interface BrowseEntry {
	name: string;
	path: string;
	accessible: boolean;
}

export async function GET(request: Request) {
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const { searchParams } = new URL(request.url);
	const rawPath = searchParams.get("path");

	// Default to home dir
	const target = rawPath ? path.resolve(rawPath) : os.homedir();

	// Verify it's a directory
	try {
		const info = await stat(target);
		if (!info.isDirectory()) {
			return NextResponse.json({ error: "Not a directory" }, { status: 400 });
		}
	} catch {
		return NextResponse.json({ error: "Path not found" }, { status: 404 });
	}

	// List entries — only directories
	let entries: BrowseEntry[] = [];
	try {
		const names = await readdir(target);
		const infos = await Promise.allSettled(
			names.map(async (name) => {
				const full = path.join(target, name);
				const info = await stat(full);
				return { name, full, isDir: info.isDirectory() };
			}),
		);
		entries = infos
			.filter(
				(r): r is PromiseFulfilledResult<{ name: string; full: string; isDir: boolean }> =>
					r.status === "fulfilled" && r.value.isDir,
			)
			.map((r) => ({ name: r.value.name, path: r.value.full, accessible: true }))
			.sort((a, b) => a.name.localeCompare(b.name));
	} catch {
		// Permission denied or similar — return empty list but still allow selection
	}

	// Parent path (null at filesystem root)
	const parent = target === path.parse(target).root ? null : path.dirname(target);

	// Quick-access shortcuts
	const home = os.homedir();
	const shortcuts = [
		{ label: "Home", path: home },
		{ label: "Root", path: "/" },
	];
	// Add common paths that exist
	for (const [label, p] of [
		["Desktop", path.join(home, "Desktop")],
		["Documents", path.join(home, "Documents")],
		["Downloads", path.join(home, "Downloads")],
	] as [string, string][]) {
		try {
			await stat(p);
			shortcuts.push({ label, path: p });
		} catch {}
	}

	return NextResponse.json({
		path: target,
		parent,
		entries,
		shortcuts,
	});
}
