/**
 * Web-tweak accept: commit a preview transaction's candidate source patch to
 * disk, iff its base file hashes still match.
 *
 * This is the ONLY place a web tweak touches the filesystem, and it does so
 * through the canonical containment primitive (resolveWorkspacePath). It writes
 * the candidate patch VERBATIM; it never re-localizes, re-synthesizes, or rebases.
 * If any base hash no longer matches on disk (a human, watcher, HMR, or other
 * agent changed the file since the preview was produced), the accept is refused
 * and the caller invalidates the transaction.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import type { BaseFile, CandidateSourcePatch } from "./preview-store";

const DENIED_SEGMENTS = [".proof", ".git"];

function sha256(buf: Buffer | string): string {
	return createHash("sha256").update(buf).digest("hex");
}

export type AcceptResult =
	| { ok: true; written: string[] }
	| { ok: false; code: "NO_CANDIDATE" | "BASE_DRIFT" | "PATH_DENIED"; detail?: string };

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

	// 1. Verify every declared base hash still matches on disk. A base file that
	//    was absent at preview time is recorded with the empty-string sha of "";
	//    we treat a missing file as sha256("") too so create-new is expressible.
	for (const bf of baseFiles) {
		const resolved = await resolveWorkspacePath(rootDir, bf.path, {
			deniedSegments: DENIED_SEGMENTS,
		});
		if (!resolved) return { ok: false, code: "PATH_DENIED", detail: bf.path };
		let cur: string;
		try {
			cur = sha256(await readFile(resolved.absolutePath));
		} catch {
			cur = sha256("");
		}
		if (cur !== bf.sha256) {
			return { ok: false, code: "BASE_DRIFT", detail: bf.path };
		}
	}

	// 2. Resolve every target path first (fail closed before any write).
	const targets: Array<{ absolutePath: string; content: string }> = [];
	for (const f of candidate.files) {
		const resolved = await resolveWorkspacePath(rootDir, f.path, {
			deniedSegments: DENIED_SEGMENTS,
			allowMissing: true,
		});
		if (!resolved) return { ok: false, code: "PATH_DENIED", detail: f.path };
		targets.push({ absolutePath: resolved.absolutePath, content: f.content });
	}

	// 3. Write. (Best-effort sequential; a partial failure surfaces to the caller,
	//    which keeps the transaction non-terminal so it can be retried.)
	const written: string[] = [];
	for (const t of targets) {
		await writeFile(t.absolutePath, t.content, "utf8");
		written.push(t.absolutePath);
	}
	return { ok: true, written };
}

export { sha256 as hashContent };
