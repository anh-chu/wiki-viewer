/**
 * Tier-1 Raw FS — atomic move/rename.
 *
 * POST /api/agent/fs/move
 * Body: { from: string, to: string, ifMatch?: string }
 *
 * Moves sidecar for .md files (R3).
 * Locks source + dest in sorted order to avoid deadlock.
 * Requires source read+mutate, dest mutate.
 */
export const runtime = "nodejs";

import { rename, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { checkAuth, enforceScope } from "@/lib/proof/auth";
import { getRootDir, safeRootPath } from "@/lib/root-dir";
import { withFileMutex } from "@/lib/proof/mutex";
import { moveSidecar } from "@/lib/proof/sidecar";
import { writeAuditRow } from "@/lib/proof/audit";
import { safeAbsPath, sha256ofBuf, extractShaHex, isMarkdown } from "@/lib/proof/raw-fs";
import { readFile } from "node:fs/promises";

function errJson(code: string, message: string, status: number): NextResponse {
	return NextResponse.json({ error: code, message }, { status });
}

export async function POST(req: Request): Promise<NextResponse> {
	const auth = await checkAuth(req);
	if (!auth.ok) return errJson("UNAUTHORIZED", auth.message ?? "Unauthorized", 401);

	let body: { from?: unknown; to?: unknown; ifMatch?: unknown };
	try {
		body = (await req.json()) as typeof body;
	} catch {
		return errJson("INVALID_PAYLOAD", "Invalid JSON body", 400);
	}

	if (typeof body.from !== "string" || !body.from) {
		return errJson("INVALID_PAYLOAD", "from (string) required", 400);
	}
	if (typeof body.to !== "string" || !body.to) {
		return errJson("INVALID_PAYLOAD", "to (string) required", 400);
	}

	const fromRel = body.from;
	const toRel = body.to;
	const ifMatch = typeof body.ifMatch === "string" ? body.ifMatch : undefined;

	// Basic traversal
	if (!safeRootPath(fromRel)) return errJson("INVALID_PATH", "from: path traversal rejected", 400);
	if (!safeRootPath(toRel)) return errJson("INVALID_PATH", "to: path traversal rejected", 400);

	const fromAbs = await safeAbsPath(fromRel);
	if (!fromAbs) return errJson("INVALID_PATH", "from: path rejected (symlink escape or denied)", 400);
	const toAbs = await safeAbsPath(toRel);
	if (!toAbs) return errJson("INVALID_PATH", "to: path rejected (symlink escape or denied)", 400);

	// Self-move guard
	if (fromAbs === toAbs) return errJson("INVALID_PATH", "from and to are the same path", 400);
	if (toAbs.startsWith(fromAbs + path.sep)) {
		return errJson("INVALID_PATH", "Cannot move a directory into itself", 400);
	}

	// Scope: source requires read+mutate; dest requires mutate
	const sc1 = enforceScope(auth.agent, { filePath: fromRel, op: "read" });
	if (!sc1.ok) return errJson(sc1.code, sc1.message, 403);
	const sc2 = enforceScope(auth.agent, { filePath: fromRel, op: "mutate" });
	if (!sc2.ok) return errJson(sc2.code, sc2.message, 403);
	const sc3 = enforceScope(auth.agent, { filePath: toRel, op: "mutate" });
	if (!sc3.ok) return errJson(sc3.code, sc3.message, 403);

	// Verify source exists
	try {
		await stat(fromAbs);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return errJson("NOT_FOUND", "Source file not found", 404);
		}
		throw e;
	}

	// If-Match guard (R4)
	let existingSha: string | undefined;
	if (ifMatch) {
		let buf: Buffer;
		try {
			buf = await readFile(fromAbs);
		} catch {
			return errJson("NOT_FOUND", "Source file not found", 404);
		}
		existingSha = sha256ofBuf(buf);
		if (extractShaHex(ifMatch) !== extractShaHex(existingSha)) {
			return errJson("PRECONDITION_FAILED", "If-Match sha256 mismatch", 412);
		}
	}

	const rootDir = getRootDir();
	const isMd = isMarkdown(fromRel);

	// Lock source + dest in sorted order to avoid deadlock
	const [first, second] = [fromRel, toRel].sort();

	const doMove = async () => {
		await rename(fromAbs, toAbs);
		if (isMd) {
			await moveSidecar(rootDir, fromRel, toRel);
		}
		writeAuditRow({
			agentId: auth.agent.id,
			op: "move",
			path: fromRel,
			newSha: toRel, // store destination in newSha field for audit trail
			forced: false,
		});
	};

	if (first === fromRel) {
		await withFileMutex(first, () => withFileMutex(second, doMove));
	} else {
		await withFileMutex(first, () => withFileMutex(second, doMove));
	}

	return NextResponse.json({ from: fromRel, to: toRel });
}
