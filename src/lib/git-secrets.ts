/**
 * Secure store for git remote tokens (PATs, deploy keys, etc.).
 * Tokens live in ~/.wiki-viewer/git-secrets.json at mode 0600.
 * They NEVER appear in config.json, logs, or API responses.
 */
import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import os from "node:os";

function dataDir(): string {
	return path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
}

function secretsPath(): string {
	return path.join(dataDir(), "git-secrets.json");
}

function readStore(): Record<string, string> {
	const p = secretsPath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
	} catch {
		return {};
	}
}

function writeStore(store: Record<string, string>): void {
	const p = secretsPath();
	writeFileSync(p, JSON.stringify(store), { mode: 0o600 });
	try {
		chmodSync(p, 0o600);
	} catch {
		// chmod is best-effort
	}
}

/** Generate a unique reference key for a stored token. */
export function genTokenRef(): string {
	return "git_" + randomBytes(9).toString("base64url");
}

/** Store a token under the given ref. Creates the file if absent. */
export async function setToken(ref: string, token: string): Promise<void> {
	await mkdir(dataDir(), { recursive: true });
	const store = readStore();
	store[ref] = token;
	writeStore(store);
}

/** Retrieve a token by ref. Returns null if ref or file is absent. */
export async function getToken(ref: string): Promise<string | null> {
	const store = readStore();
	return store[ref] ?? null;
}

/** Remove a token. No-op if ref does not exist. */
export async function deleteToken(ref: string): Promise<void> {
	const store = readStore();
	if (!(ref in store)) return;
	delete store[ref];
	writeStore(store);
}
