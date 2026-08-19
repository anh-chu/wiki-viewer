import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { withFileLock } from "@/lib/proof/file-lock";

export interface ContainedWriteBase {
	path: string;
	sha256: string;
}

export interface ContainedWriteTarget {
	relPath: string;
	/** Hash of current content. null/undefined skips the hash check. */
	expectedBaseHash?: string | null;
	content: string;
}

export interface ContainedWriteRequest extends ContainedWriteTarget {
	rootDir: string;
	/** Additional base files to verify before writing this target. */
	baseFiles?: readonly ContainedWriteBase[];
}

export interface ContainedWriteBatchRequest {
	rootDir: string;
	targets: readonly ContainedWriteTarget[];
	/** Base files are all checked before any target is written. */
	baseFiles?: readonly ContainedWriteBase[];
}

export type ContainedWriteResult =
	| { ok: true; written: string[] }
	| { ok: false; code: "BASE_DRIFT" | "PATH_DENIED"; detail?: string };

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

async function currentHash(absolutePath: string): Promise<string> {
	try {
		return sha256(await readFile(absolutePath));
	} catch {
		// Missing file hashes as sha256("") so create-new is expressible.
		return sha256("");
	}
}

/** Reject a path whose final component is a symlink (post-resolve guard). */
async function isSymlink(absolutePath: string): Promise<boolean> {
	try {
		const st = await lstat(absolutePath);
		return st.isSymbolicLink();
	} catch {
		return false;
	}
}

async function resolveBase(
	rootDir: string,
	base: ContainedWriteBase,
): Promise<{ absolutePath: string; hash: string } | { ok: false; code: "BASE_DRIFT" | "PATH_DENIED"; detail?: string }> {
	const resolved = await resolveWorkspacePath(rootDir, base.path, {
		deniedSegments: DENIED_SEGMENTS,
		allowMissing: true,
	});
	if (!resolved) return { ok: false, code: "PATH_DENIED", detail: base.path };
	if (await isSymlink(resolved.absolutePath)) {
		return { ok: false, code: "PATH_DENIED", detail: base.path };
	}
	if ((await currentHash(resolved.absolutePath)) !== base.sha256) {
		return { ok: false, code: "BASE_DRIFT", detail: base.path };
	}
	return { absolutePath: resolved.absolutePath, hash: base.sha256 };
}

/**
 * Write workspace-contained files after checking every declared base hash. The
 * write is serialized with other contained writes for this workspace, written
 * through sibling temporary files, then atomically renamed into place.
 */
export async function containedWriteBatch(
	input: ContainedWriteBatchRequest,
): Promise<ContainedWriteResult> {
	return withFileLock(`contained-write\0${input.rootDir}`, async () => {
		const baseByPath = new Map<string, string>();
		for (const base of input.baseFiles ?? []) {
			const checked = await resolveBase(input.rootDir, base);
			if ("ok" in checked) return checked;
			baseByPath.set(checked.absolutePath, checked.hash);
		}

		const targets: Array<{ absolutePath: string; content: string; base?: string; detail: string }> = [];
		for (const target of input.targets) {
			const resolved = await resolveWorkspacePath(input.rootDir, target.relPath, {
				deniedSegments: DENIED_SEGMENTS,
				allowMissing: true,
			});
			if (!resolved) return { ok: false, code: "PATH_DENIED", detail: target.relPath };
			const base =
				target.expectedBaseHash == null
					? baseByPath.get(resolved.absolutePath)
					: target.expectedBaseHash;
			targets.push({ absolutePath: resolved.absolutePath, content: target.content, base, detail: target.relPath });
		}

		const written: string[] = [];
		for (const target of targets) {
			if (await isSymlink(target.absolutePath)) {
				return { ok: false, code: "PATH_DENIED", detail: target.detail };
			}
			if (target.base !== undefined && (await currentHash(target.absolutePath)) !== target.base) {
				return { ok: false, code: "BASE_DRIFT", detail: target.detail };
			}
			const tmp = path.join(
				path.dirname(target.absolutePath),
				`.wv-tweak-${randomBytes(6).toString("hex")}.tmp`,
			);
			try {
				await writeFile(tmp, target.content, "utf8");
				await rename(tmp, target.absolutePath);
			} catch (error) {
				await unlink(tmp).catch(() => {});
				throw error;
			}
			written.push(target.absolutePath);
		}
		return { ok: true, written };
	});
}

/** Write one workspace-contained file using the shared contained-write core. */
export async function containedWrite(input: ContainedWriteRequest): Promise<ContainedWriteResult> {
	return containedWriteBatch({
		rootDir: input.rootDir,
		targets: [input],
		baseFiles: input.baseFiles,
	});
}

export { sha256 as hashContent };
