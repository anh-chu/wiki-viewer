import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { getShareByToken, isExpired, type SharedDoc } from "./db";
import { getWorkspace } from "@/lib/workspaces";
import { safeAbsPath } from "@/lib/proof/raw-fs";

export interface ResolvedShareTarget {
	share: SharedDoc;
	absPath: string;
	filename: string;
}

/**
 * Resolve a share token to a readable, non-directory file target.
 * Centralises share lookup, revocation, expiry, workspace existence,
 * path containment, and file existence checks.
 */
export async function resolveShareTarget(
	token: string,
): Promise<{ ok: true; target: ResolvedShareTarget } | { ok: false; response: NextResponse }> {
	const share = getShareByToken(token);
	if (!share) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "not_found", message: "Share link not found" },
				{ status: 404 },
			),
		};
	}

	if (share.isRevoked) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "revoked", message: "Share link has been revoked" },
				{ status: 410 },
			),
		};
	}

	if (isExpired(share)) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "expired", message: "Share link has expired" },
				{ status: 410 },
			),
		};
	}

	const ws = await getWorkspace(share.workspaceId);
	if (!ws) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "workspace_gone", message: "Workspace no longer exists" },
				{ status: 410 },
			),
		};
	}

	const absPath = await safeAbsPath(ws.rootDir, share.filePath);
	if (!absPath) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "path_invalid", message: "Invalid file path" },
				{ status: 400 },
			),
		};
	}

	let info;
	try {
		info = await stat(absPath);
	} catch {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "file_gone", message: "File no longer exists" },
				{ status: 410 },
			),
		};
	}

	if (info.isDirectory()) {
		return {
			ok: false,
			response: NextResponse.json(
				{ error: "path_invalid", message: "Directories cannot be shared" },
				{ status: 400 },
			),
		};
	}

	const filename = share.filePath.split("/").pop() ?? share.filePath;
	return { ok: true, target: { share, absPath, filename } };
}
