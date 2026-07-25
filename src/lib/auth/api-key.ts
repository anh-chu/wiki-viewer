/**
 * Embed API key management.
 * Generates a random 64-char hex key at startup and persists it to
 * ~/.wiki-viewer/api-key (chmod 600). termyard reads the same file from Go.
 * validateApiKey uses constant-time comparison to prevent timing attacks.
 */
import path from "node:path";
import os from "node:os";
import {
	mkdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	chmodSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";

const DATA_DIR = path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
const KEY_PATH = path.join(DATA_DIR, "api-key");

/**
 * Ensure ~/.wiki-viewer/api-key exists; generate if missing.
 * Returns the current key. Safe to call multiple times (idempotent).
 */
export function ensureApiKey(): string {
	mkdirSync(DATA_DIR, { recursive: true });
	if (!existsSync(KEY_PATH)) {
		const key = randomBytes(32).toString("hex");
		writeFileSync(KEY_PATH, key, { mode: 0o600 });
		try {
			chmodSync(KEY_PATH, 0o600);
		} catch {
			// chmod best-effort (some platforms don't support it)
		}
		return key;
	}
	return readFileSync(KEY_PATH, "utf-8").trim();
}

/**
 * Read the stored key. Returns empty string if the file doesn't exist yet
 * (shouldn't happen after ensureApiKey() runs at startup).
 */
export function getApiKey(): string {
	if (!existsSync(KEY_PATH)) return "";
	return readFileSync(KEY_PATH, "utf-8").trim();
}

/**
 * Rotate: generate a new key, overwrite the file, return it.
 */
export function rotateApiKey(): string {
	mkdirSync(DATA_DIR, { recursive: true });
	const key = randomBytes(32).toString("hex");
	writeFileSync(KEY_PATH, key, { mode: 0o600 });
	try {
		chmodSync(KEY_PATH, 0o600);
	} catch {
		// best-effort
	}
	return key;
}

/**
 * Constant-time key comparison. Returns false for empty or length-mismatched keys.
 */
export function validateApiKey(key: string): boolean {
	const stored = getApiKey();
	if (!stored || !key) return false;
	// Length check before timingSafeEqual (which requires equal-length buffers).
	// This leaks key length, but the stored key is always 64 chars; an attacker
	// already knows that from the public spec.
	if (stored.length !== key.length) return false;
	try {
		return timingSafeEqual(
			Buffer.from(stored, "utf-8"),
			Buffer.from(key, "utf-8"),
		);
	} catch {
		return false;
	}
}
