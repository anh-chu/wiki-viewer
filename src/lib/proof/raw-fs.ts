/**
 * Shared utilities for Tier-1 raw-fs routes.
 *
 * - Path safety (symlink escape guard, hard-denied paths)
 * - SHA-256 of Buffer
 * - Best-effort MIME by extension
 * - Atomic write (tmp → rename, preserves mode)
 */
import { createHash } from "node:crypto";
import { open, stat, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { DENIED_SEGMENTS } from "@/lib/fs/denied-segments";
import { resolveWorkspacePath } from "@/lib/fs/workspace-path";
import { contentTypeForPath } from "@/lib/mime";


// ── Denied path checks ──────────────────────────────────────────────────────

/**
 * True if the root-relative path is hard-denied regardless of scope.
 * Denied segments (see DENIED_SEGMENTS):
 * - .proof/     — sidecar storage (Tier-2 internal)
 * - .git/       — git objects (sensitive)
 */
export function isDeniedRelPath(rel: string): boolean {
	const norm = rel.replace(/\\/g, "/");
	return DENIED_SEGMENTS.some((seg) => norm === seg || norm.startsWith(seg + "/"));
}

export function isMarkdown(filePath: string): boolean {
	return filePath.endsWith(".md") || filePath.endsWith(".markdown");
}

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Compatibility wrapper around `resolveWorkspacePath()`.
 *
 * Still used by a few agent/share routes that will migrate in a later phase.
 * It allows non-existent targets (mkdirs-style creates) but rejects escapes
 * through symlinks by climbing to the nearest real ancestor.
 */
export async function safeAbsPath(root: string, rel: string): Promise<string | null> {
	if (!root) return null;
	const resolved = await resolveWorkspacePath(root, rel, {
		allowMissing: true,
		deniedSegments: DENIED_SEGMENTS,
	});
	return resolved?.absolutePath ?? null;
}

// ── Hashing ──────────────────────────────────────────────────────────────────

/** Returns "sha256:<hex>" — the canonical sha format used in ETag / audit. */
export function sha256ofBuf(buf: Buffer): string {
	return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

/**
 * Normalise an If-Match / ETag header value to bare hex.
 * Strips outer double-quotes and "sha256:" prefix.
 */
export function extractShaHex(header: string): string {
	return header
		.replace(/^"/, "")
		.replace(/"$/, "")
		.replace(/^sha256:/, "");
}

// ── MIME ──────────────────────────────────────────────────────────────────────

export function mimeByExt(filePath: string): string {
	return contentTypeForPath(filePath);
}

// ── Binary detection ──────────────────────────────────────────────────────────

/** Heuristic: buffer contains a null byte in first 8 KB → treat as binary. */
export function looksLikeBinary(buf: Buffer): boolean {
	const sample = buf.slice(0, Math.min(buf.length, 8192));
	return sample.includes(0);
}

// ── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Write `data` to `absPath` atomically:
 *   1. Write to a sibling .tmp file
 *   2. datasync the tmp file
 *   3. rename tmp → target
 *
 * Preserves the unix mode of the existing file.
 * Caller is responsible for creating parent dirs.
 */
export async function atomicWrite(absPath: string, data: Buffer): Promise<void> {
	// Preserve mode of existing file
	let mode = 0o644;
	try {
		const st = await stat(absPath);
		mode = st.mode & 0o777;
	} catch {
		// New file — use 0o644 default
	}

	const tmp = absPath + ".~" + process.pid + "." + Date.now() + ".tmp";
	const fh = await open(tmp, "w", mode);
	try {
		await fh.write(data);
		await fh.datasync();
	} finally {
		await fh.close();
	}
	await rename(tmp, absPath);
}

/** Ensure parent directory exists; creates intermediate dirs if mkdirs=true. */
export async function ensureParentDir(absPath: string, mkdirs: boolean): Promise<boolean> {
	const dir = path.dirname(absPath);
	if (mkdirs) {
		await mkdir(dir, { recursive: true });
		return true;
	}
	try {
		await stat(dir);
		return true;
	} catch {
		return false;
	}
}
