/**
 * Web-tweak accept: commit a preview transaction's candidate source patch to
 * disk, iff its base file hashes still match.
 *
 * This is the ONLY place a web tweak touches the filesystem, and it does so
 * through the canonical containment primitive (resolveWorkspacePath). It writes
 * the candidate patch VERBATIM; it never re-localizes, re-synthesizes, or rebases.
 *
 * Hardening against TOCTOU / partial commits:
 *  - Web-tweak accepts are serialized per workspace (in-process mutex) so two
 *    tweak accepts don't interleave. This lock covers web-tweak commits only;
 *    other wiki-viewer write paths are not on this lock and are detected only
 *    best-effort by the hash checks below. The route additionally claims the
 *    preview atomically in the DB before calling here, so only one accept runs
 *    per transaction.
 *  - Each target is re-checked immediately before writing: the resolved path must
 *    not be a symlink (lstat) and, if it exists, must still hash to its declared
 *    base. This only shrinks (does not close) the TOCTOU window: it narrows to
 *    the gap between the final re-hash and the atomic rename. It is not a
 *    filesystem CAS: an external writer that races
 *    inside that gap, or that swaps an ancestor directory for a symlink, is not
 *    fully prevented here. Single-host WAL + the per-workspace lock make this
 *    adequate for wiki-viewer's own writers; a hostile concurrent external writer
 *    is out of scope for v1.
 *  - Each file is written to a temp file in the same directory and atomically
 *    renamed into place, so a crash mid-write cannot leave a half-written file.
 *  - v1 candidates are single-file (enforced at reply time), so "BASE_DRIFT =>
 *    nothing written" holds without multi-file rollback.
 *
 * Note: base hashes are verified twice — once up front (fail fast before any
 * write) and once per file right before its write (shrinks, does not fully
 * close, the TOCTOU window; see the per-target note above).
 */
import { readFile, writeFile, lstat, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import type { BaseFile, CandidateSourcePatch } from "./preview-store";

import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

/** Per-workspace serialization of commits (single-host; SQLite WAL is too). */
const workspaceLocks = new Map<string, Promise<unknown>>();
async function withWorkspaceLock<T>(rootDir: string, fn: () => Promise<T>): Promise<T> {
	const prev = workspaceLocks.get(rootDir) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => {
		release = r;
	});
	// Chain this commit after any in-flight one for the same workspace.
	const chained = prev.then(() => next);
	workspaceLocks.set(rootDir, chained);
	await prev.catch(() => {});
	try {
		return await fn();
	} finally {
		release();
		// Drop the map entry only if we are still the tail (no later waiter chained).
		if (workspaceLocks.get(rootDir) === chained) {
			workspaceLocks.delete(rootDir);
		}
	}
}

export type AcceptResult =
	| { ok: true; written: string[] }
	| {
			ok: false;
			code: "NO_CANDIDATE" | "BASE_DRIFT" | "PATH_DENIED";
			detail?: string;
	  };

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
		return false; // missing is fine (create-new)
	}
}

/**
 * Verify base hashes then write the candidate patch. rootDir is the workspace
 * root; every patch/base path is contained under it.
 */
export async function commitCandidate(
	rootDir: string,
	baseFiles: BaseFile[],
	candidate: CandidateSourcePatch | null,
): Promise<AcceptResult> {
	if (!candidate || candidate.files.length === 0) {
		return { ok: false, code: "NO_CANDIDATE" };
	}

	return withWorkspaceLock(rootDir, async () => {
		// Map declared base hashes by resolved absolute path for the pre-write check.
		const baseByPath = new Map<string, string>();
		for (const bf of baseFiles) {
			const resolved = await resolveWorkspacePath(rootDir, bf.path, {
				deniedSegments: DENIED_SEGMENTS,
				allowMissing: true,
			});
			if (!resolved) return { ok: false, code: "PATH_DENIED", detail: bf.path };
			if (await isSymlink(resolved.absolutePath)) {
				return { ok: false, code: "PATH_DENIED", detail: bf.path };
			}
			baseByPath.set(resolved.absolutePath, bf.sha256);
			// 1a. Fail fast: every declared base must currently match.
			if ((await currentHash(resolved.absolutePath)) !== bf.sha256) {
				return { ok: false, code: "BASE_DRIFT", detail: bf.path };
			}
		}

		// 2. Resolve every target path (fail closed before any write). Every target
		//    must have a declared base hash (enforced at reply time, re-checked here).
		const targets: Array<{ absolutePath: string; content: string; base: string }> = [];
		for (const f of candidate.files) {
			const resolved = await resolveWorkspacePath(rootDir, f.path, {
				deniedSegments: DENIED_SEGMENTS,
				allowMissing: true,
			});
			if (!resolved) return { ok: false, code: "PATH_DENIED", detail: f.path };
			const base = baseByPath.get(resolved.absolutePath);
			if (base === undefined) {
				return { ok: false, code: "BASE_DRIFT", detail: f.path };
			}
			targets.push({ absolutePath: resolved.absolutePath, content: f.content, base });
		}

		// 3. Commit. Per file, right before writing: re-check no-symlink + hash, then
		//    write to a sibling temp file and atomically rename into place.
		const written: string[] = [];
		for (const t of targets) {
			if (await isSymlink(t.absolutePath)) {
				return { ok: false, code: "PATH_DENIED", detail: t.absolutePath };
			}
			if ((await currentHash(t.absolutePath)) !== t.base) {
				return { ok: false, code: "BASE_DRIFT", detail: t.absolutePath };
			}
			const tmp = path.join(
				path.dirname(t.absolutePath),
				`.wv-tweak-${randomBytes(6).toString("hex")}.tmp`,
			);
			try {
				await writeFile(tmp, t.content, "utf8");
				await rename(tmp, t.absolutePath);
			} catch (e) {
				await unlink(tmp).catch(() => {});
				throw e;
			}
			written.push(t.absolutePath);
		}
		return { ok: true, written };
	});
}

export { sha256 as hashContent };
