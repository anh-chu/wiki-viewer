/**
 * Agent registry.
 *
 * Persists to ~/.wiki-viewer/agents.json (agent records).
 * Human authentication is handled by Better Auth (see src/lib/auth/server.ts).
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutex } from "./mutex";

// Sentinel key for all registry write operations
const REGISTRY_MUTEX_KEY = "__registry__";

// Throttle updateLastSeen: skip if updated < 30s ago
const lastSeenWriteAt: Map<string, number> = new Map();
const LAST_SEEN_THROTTLE_MS = 30_000;

export interface AgentScope {
	paths: string[]; // glob patterns
	ops: Array<"read" | "mutate" | "delete">;
	/**
	 * If set, this agent may only operate in this specific workspace (by id).
	 * Undefined = wildcard: any workspace is allowed (back-compat for existing agents).
	 */
	workspaceId?: string;
}

export interface Agent {
	id: string;
	displayName: string;
	tokenHash: string; // sha256 hex of raw token
	scope: AgentScope;
	createdAt: string; // ISO-8601
	lastSeen: string; // ISO-8601
	/** Better Auth user.id of the owner who approved this agent. Undefined for legacy entries. */
	ownerUserId?: string;
}

export interface Registry {
	version: 1;
	agents: Agent[];
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function wikiViewerDir(): string {
	// Prefer HOME env var so tests can override by setting process.env.HOME.
	const home = process.env.HOME ?? os.homedir();
	return path.join(home, ".wiki-viewer");
}

function agentsJsonPath(): string {
	return path.join(wikiViewerDir(), "agents.json");
}


// ── Hashing ───────────────────────────────────────────────────────────────────

export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
	// Pad to equal length before comparing to avoid length-based timing leak
	const bufA = Buffer.from(a.padEnd(64, "0"), "utf8");
	const bufB = Buffer.from(b.padEnd(64, "0"), "utf8");
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB) && a.length === b.length;
}

// ── Read / Write ──────────────────────────────────────────────────────────────

export async function readRegistry(): Promise<Registry | null> {
	try {
		const raw = await readFile(agentsJsonPath(), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		// Migrate: silently drop legacy `owner` field if present
		return {
			version: 1,
			agents: Array.isArray(parsed.agents) ? (parsed.agents as Agent[]) : [],
		};
	} catch {
		return null;
	}
}

/** Inner write — caller must already hold REGISTRY_MUTEX_KEY or be in single-writer context. */
async function _writeRegistryUnsafe(r: Registry): Promise<void> {
	await mkdir(wikiViewerDir(), { recursive: true });
	const tmp = agentsJsonPath() + ".tmp";
	await writeFile(tmp, JSON.stringify(r, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		await chmod(tmp, 0o600);
	} catch {
		// Non-fatal on Windows/some environments
	}
	await rename(tmp, agentsJsonPath());
}

export async function writeRegistry(r: Registry): Promise<void> {
	await withFileMutex(REGISTRY_MUTEX_KEY, () => _writeRegistryUnsafe(r));
}

// ── Ensure registry (creates if missing) ─────────────────────────────────────

/**
 * Public: creates registry if missing. Acquires the mutex itself.
 * Do NOT call from inside a mutex-held context.
 */
export async function ensureRegistry(): Promise<Registry> {
	const existing = await readRegistry();
	if (existing) return existing;

	const r: Registry = { version: 1, agents: [] };
	await writeRegistry(r); // acquires lock
	return r;
}

/**
 * Inner ensure — for use within a locked context.
 * Creates registry if missing using unlocked write.
 */
async function _ensureRegistryUnsafe(): Promise<Registry> {
	const existing = await readRegistry();
	if (existing) return existing;

	const r: Registry = { version: 1, agents: [] };
	await _writeRegistryUnsafe(r);
	return r;
}

// ── Agent lookups ─────────────────────────────────────────────────────────────

export async function lookupAgentByToken(token: string): Promise<Agent | null> {
	const r = await readRegistry();
	if (!r) return null;
	const candidate = hashToken(token);
	for (const agent of r.agents) {
		if (timingSafeEqualHex(agent.tokenHash, candidate)) {
			return agent;
		}
	}
	return null;
}

export async function lookupAgentById(id: string): Promise<Agent | null> {
	const r = await readRegistry();
	if (!r) return null;
	return r.agents.find((a) => a.id === id) ?? null;
}

export async function addAgent(agent: Agent): Promise<void> {
	await withFileMutex(REGISTRY_MUTEX_KEY, async () => {
		const r = await _ensureRegistryUnsafe(); // no re-entrant lock
		// Replace if id already present
		const idx = r.agents.findIndex((a) => a.id === agent.id);
		if (idx >= 0) {
			r.agents[idx] = agent;
		} else {
			r.agents.push(agent);
		}
		await _writeRegistryUnsafe(r);
	});
}

export async function removeAgent(id: string): Promise<boolean> {
	return withFileMutex(REGISTRY_MUTEX_KEY, async () => {
		const r = await readRegistry();
		if (!r) return false;
		const before = r.agents.length;
		r.agents = r.agents.filter((a) => a.id !== id);
		if (r.agents.length === before) return false;
		await _writeRegistryUnsafe(r);
		return true;
	});
}

export async function updateLastSeen(id: string): Promise<void> {
	// Throttle: skip if updated recently
	const now = Date.now();
	const last = lastSeenWriteAt.get(id) ?? 0;
	if (now - last < LAST_SEEN_THROTTLE_MS) return;

	await withFileMutex(REGISTRY_MUTEX_KEY, async () => {
		const r = await readRegistry();
		if (!r) return;
		const agent = r.agents.find((a) => a.id === id);
		if (!agent) return;
		agent.lastSeen = new Date().toISOString();
		lastSeenWriteAt.set(id, Date.now());
		await _writeRegistryUnsafe(r);
	});
}
