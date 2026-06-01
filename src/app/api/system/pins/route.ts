import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { requireUser } from "@/lib/auth/server";
import { readConfig, writeConfig } from "@/lib/config";

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;
	const auth = await requireUser(request);
	if (!auth.ok) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

	const body: { path?: string; action?: "pin" | "unpin" } = await request.json();
	const p = body.path?.trim();
	const action = body.action ?? "pin";
	if (!p) return NextResponse.json({ error: "Missing path" }, { status: 400 });

	if (action === "pin") {
		try {
			const info = await stat(p);
			if (!info.isDirectory())
				return NextResponse.json({ error: "Not a directory" }, { status: 400 });
		} catch {
			return NextResponse.json({ error: "Path not found" }, { status: 404 });
		}
		const config = await readConfig();
		const pins = config.pinnedPaths ?? [];
		if (!pins.includes(p)) {
			await writeConfig({ pinnedPaths: [...pins, p] });
		}
	} else {
		const config = await readConfig();
		const pins = (config.pinnedPaths ?? []).filter((x) => x !== p);
		await writeConfig({ pinnedPaths: pins });
	}

	return NextResponse.json({ ok: true });
}
