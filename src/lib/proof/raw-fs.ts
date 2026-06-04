/**
 * Shared utilities for Tier-1 raw-fs routes.
 *
 * - Path safety (symlink escape guard, hard-denied paths)
 * - SHA-256 of Buffer
 * - Best-effort MIME by extension
 * - Atomic write (tmp → rename, preserves mode)
 */
import { createHash } from "node:crypto";
import { open, stat, rename, realpath, mkdir } from "node:fs/promises";
import path from "node:path";


// ── Denied path checks ──────────────────────────────────────────────────────

/**
 * True if the root-relative path is hard-denied regardless of scope.
 * - .proof/ — sidecar storage (Tier-2 internal)
 * - .git/   — git objects (sensitive)
 */
export function isDeniedRelPath(rel: string): boolean {
	const norm = rel.replace(/\\/g, "/");
	return (
		norm === ".proof" ||
		norm.startsWith(".proof/") ||
		norm === ".git" ||
		norm.startsWith(".git/")
	);
}

export function isMarkdown(filePath: string): boolean {
	return filePath.endsWith(".md") || filePath.endsWith(".markdown");
}

// ── Path safety ──────────────────────────────────────────────────────────────

/**
 * Resolve the absolute path for `rel`, checking:
 *  1. basic traversal (path.join containment)
 *  2. hard-denied prefixes (.proof/, .git/)
 *  3. symlink escape: if file exists, realpath must still be under root
 *
 * For non-existent targets (creates), resolves parent dir instead.
 *
 * Returns absolute path on success, null on rejection.
 */
export async function safeAbsPath(root: string, rel: string): Promise<string | null> {
	if (!root) return null;

	// Normalise and basic traversal guard
	const normalised = path.normalize(rel);
	if (normalised.startsWith("..") || path.isAbsolute(normalised)) return null;

	if (isDeniedRelPath(normalised)) return null;

	const abs = path.join(root, normalised);
	// Re-check containment after normalize
	if (abs !== root && !abs.startsWith(root + path.sep)) return null;

	// Symlink-escape check: resolve realpath of the nearest existing ancestor
	try {
		const real = await realpath(abs);
		if (real !== root && !real.startsWith(root + path.sep)) return null;
	} catch {
		// Target doesn't exist — check parent
		const parent = path.dirname(abs);
		if (parent !== abs) {
			try {
				const parentReal = await realpath(parent);
				if (parentReal !== root && !parentReal.startsWith(root + path.sep)) {
					return null;
				}
			} catch {
				// Parent doesn't exist either — containment already checked above
			}
		}
	}

	return abs;
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

const MIME_MAP: Record<string, string> = {
	".md":       "text/markdown; charset=utf-8",
	".markdown": "text/markdown; charset=utf-8",
	".txt":      "text/plain; charset=utf-8",
	".json":     "application/json; charset=utf-8",
	".jsonc":    "application/json; charset=utf-8",
	".ts":       "text/typescript; charset=utf-8",
	".tsx":      "text/typescript; charset=utf-8",
	".mts":      "text/typescript; charset=utf-8",
	".js":       "text/javascript; charset=utf-8",
	".jsx":      "text/javascript; charset=utf-8",
	".mjs":      "text/javascript; charset=utf-8",
	".html":     "text/html; charset=utf-8",
	".htm":      "text/html; charset=utf-8",
	".css":      "text/css; charset=utf-8",
	".yaml":     "text/yaml; charset=utf-8",
	".yml":      "text/yaml; charset=utf-8",
	".toml":     "text/toml; charset=utf-8",
	".xml":      "application/xml; charset=utf-8",
	".svg":      "image/svg+xml",
	".png":      "image/png",
	".jpg":      "image/jpeg",
	".jpeg":     "image/jpeg",
	".gif":      "image/gif",
	".webp":     "image/webp",
	".pdf":      "application/pdf",
	".zip":      "application/zip",
	".tar":      "application/x-tar",
	".gz":       "application/gzip",
	".py":       "text/x-python; charset=utf-8",
	".rs":       "text/x-rustsrc; charset=utf-8",
	".go":       "text/x-go; charset=utf-8",
	".sh":       "text/x-shellscript; charset=utf-8",
	".csv":      "text/csv; charset=utf-8",
	".env":      "text/plain; charset=utf-8",
};

export function mimeByExt(filePath: string): string {
	const ext = path.extname(filePath).toLowerCase();
	return MIME_MAP[ext] ?? "application/octet-stream";
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
