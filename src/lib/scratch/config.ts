import { randomBytes } from "node:crypto";

/** Hidden directory (at workspace root) holding scratchpad files. */
export const SCRATCH_DIR = ".scratch";

/** Scratch files older than this are swept. Default 7 days. */
export const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Max bytes accepted for a dropped scratch file. Mirrors the upload ceiling. */
export const SCRATCH_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Normalize a requested extension to a short, safe token.
 * Strips a leading dot, lowercases, keeps [a-z0-9], caps length, falls back to
 * "txt" when nothing usable remains.
 */
export function sanitizeExt(ext: string | undefined | null): string {
	const raw = (ext ?? "").replace(/^\./, "").toLowerCase();
	const cleaned = raw.replace(/[^a-z0-9]/g, "").slice(0, 12);
	return cleaned || "txt";
}

/** Derive a sanitized extension from an uploaded filename. */
export function extFromFilename(name: string | undefined | null): string {
	if (!name) return "txt";
	const base = name.split("/").pop() ?? name;
	const dot = base.lastIndexOf(".");
	if (dot <= 0 || dot === base.length - 1) return "txt";
	return sanitizeExt(base.slice(dot + 1));
}

/** Generate a unique scratch file path relative to the workspace root. */
export function newScratchRelPath(ext: string): string {
	const safe = sanitizeExt(ext);
	const rand = randomBytes(3).toString("hex");
	return `${SCRATCH_DIR}/scratch-${Date.now()}-${rand}.${safe}`;
}
