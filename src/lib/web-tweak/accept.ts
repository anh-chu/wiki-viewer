/**
 * Web-tweak accept: commit a preview transaction's candidate source patch to
 * disk, iff its base file hashes still match.
 *
 * The contained-write primitive owns path containment, base-hash checks,
 * workspace locking, symlink rejection, and atomic replacement. This module
 * only adapts preview candidates to that writer and preserves the accept result.
 */
import { containedWrite, hashContent } from "@/lib/fs/contained-write";
import type { BaseFile, CandidateSourcePatch } from "./preview-store";

export type AcceptResult =
	| { ok: true; written: string[] }
	| {
			ok: false;
			code: "NO_CANDIDATE" | "BASE_DRIFT" | "PATH_DENIED";
			detail?: string;
	  };

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

	const written: string[] = [];
	for (const file of candidate.files) {
		const base = baseFiles.find((entry) => entry.path === file.path);
		if (!base) return { ok: false, code: "BASE_DRIFT", detail: file.path };
		const result = await containedWrite({
			rootDir,
			relPath: file.path,
			expectedBaseHash: base.sha256,
			content: file.content,
			baseFiles,
		});
		if (!result.ok) return result;
		written.push(...result.written);
	}
	return { ok: true, written };
}

export { hashContent };
