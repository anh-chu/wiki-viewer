import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { safeRootPath } from "@/lib/root-dir";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok)
		return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: { path?: string } = await request.json();
	const rel = body.path;

	if (!rel || typeof rel !== "string" || /[<>:"|?*]/.test(rel)) {
		return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
	}
	if (rel.endsWith("/")) {
		return NextResponse.json({ error: "Invalid file path" }, { status: 400 });
	}

	const filePath = safeRootPath(rel);
	if (!filePath)
		return NextResponse.json({ error: "Invalid path" }, { status: 400 });

	try {
		await stat(filePath);
		return NextResponse.json(
			{ error: "File already exists", path: rel },
			{ status: 409 },
		);
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code !== "ENOENT") {
			return NextResponse.json(
				{ error: "Failed to create file" },
				{ status: 500 },
			);
		}
	}

	try {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, "", "utf-8");
		return NextResponse.json({ ok: true, path: rel });
	} catch {
		return NextResponse.json(
			{ error: "Failed to create file" },
			{ status: 500 },
		);
	}
}
