/**
 * Workspace fixture helper for proof tests.
 *
 * Creates isolated temporary directories and registers them as real workspaces
 * so routes resolve via the registry instead of a process-global root.
 */
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Workspace } from "../../../lib/workspaces.js";

export interface CreatedWorkspace {
	workspace: Workspace;
	rootDir: string;
}

export async function createTestWorkspace(input?: {
	name?: string;
	creatorUserId?: string;
	allowedUserIds?: string[];
	readOnly?: boolean;
}): Promise<CreatedWorkspace> {
	const rootDir = await mkdtemp(path.join(tmpdir(), "wiki-ws-"));

	const { createWorkspace, setWorkspaceAccess } = await import(
		"../../../lib/workspaces.js"
	);

	const ws = await createWorkspace({
		rootDir,
		name: input?.name ?? path.basename(rootDir),
		createdBy: input?.creatorUserId,
	});

	if (input?.allowedUserIds?.length) {
		await setWorkspaceAccess(ws.id, input.allowedUserIds);
	}

	if (input?.readOnly) {
		const { updateConfig } = await import("../../../lib/config.js");
		await updateConfig((cfg) => ({
			...cfg,
			workspaces: (cfg.workspaces ?? []).map((w) =>
				w.id === ws.id ? { ...w, readOnly: true } : w,
			) as Workspace[],
		}));
	}

	return { workspace: ws, rootDir };
}

export async function makeFile(rootDir: string, relPath: string, content: Buffer | string): Promise<void> {
	const absolute = path.join(rootDir, relPath);
	await mkdir(path.dirname(absolute), { recursive: true });
	await writeFile(absolute, content);
}

export function apiUrl(wsId: string, route: string, relPath?: string): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", wsId);
	if (relPath) url.searchParams.set("path", relPath);
	return url.toString();
}
