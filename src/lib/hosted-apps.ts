/**
 * Hosted-apps registry.
 *
 * Persists the set of hosted apps to ~/.wiki-viewer/hosted-apps.json, mirroring
 * the agent registry pattern (src/lib/proof/registry.ts): a single in-memory
 * source of truth with write-through to a JSON file, serialized through a file
 * mutex so concurrent read-modify-write callers can't lose updates.
 *
 * An entry maps a short, user-chosen slug to a directory in a workspace. Two
 * kinds exist:
 *   - `node`: a node-app directory launched through the app runner. Optional
 *     `script` picks the npm script; the running port is resolved from the app
 *     runner per request (never persisted here).
 *   - `html`: a static HTML directory served dir-aware. No process.
 *
 * Runtime status (running/port/error/logs) is NOT stored here — it is derived
 * from the app runner at read time. This module only owns the durable mapping.
 *
 * Slugs are globally scoped (unique across all workspaces) for this first cut.
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withFileMutex } from "./proof/mutex";

const HOSTED_APPS_MUTEX_KEY = "__hosted_apps__";

export type HostedAppType = "node" | "html";

export interface HostedApp {
	slug: string;
	type: HostedAppType;
	workspaceId: string;
	/** Root-relative directory within the workspace. "" means the workspace root. */
	relPath: string;
	/** Node only: npm script to launch. Undefined = app runner's default choice. */
	script?: string;
	/** Node only: pin to persist. Reserved for a later ticket; not acted on here. */
	persist?: boolean;
	createdAt: string; // ISO-8601
}

export interface HostedAppsRegistry {
	version: 1;
	apps: HostedApp[];
}

// ── Slug rules ─────────────────────────────────────────────────────────────────

/** Lowercase alphanumeric plus hyphen, must start with alphanumeric. */
export const SLUG_REGEX = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Reserved top-level names a slug may not take. `/app/<slug>` lives under the
 * `app` segment, but a slug that collides with another top-level route segment
 * (or a common reserved word) is rejected to avoid confusion and future clashes.
 */
export const RESERVED_SLUGS = new Set([
	"api",
	"app",
	"apps",
	"s",
	"signin",
	"signout",
	"_next",
	"assets",
	"upload",
	"owner",
	"share",
	"static",
	"public",
	"favicon.ico",
]);

export type SlugValidation =
	| { ok: true }
	| { ok: false; code: "SLUG_REQUIRED" | "SLUG_INVALID" | "SLUG_RESERVED" };

export function validateSlug(slug: unknown): SlugValidation {
	if (typeof slug !== "string" || slug.length === 0) {
		return { ok: false, code: "SLUG_REQUIRED" };
	}
	if (!SLUG_REGEX.test(slug)) {
		return { ok: false, code: "SLUG_INVALID" };
	}
	if (RESERVED_SLUGS.has(slug)) {
		return { ok: false, code: "SLUG_RESERVED" };
	}
	return { ok: true };
}

/** Kebab-case a directory name into a slug-shaped default (best effort). */
export function defaultSlugFromName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function wikiViewerDir(): string {
	// Prefer HOME env var so tests can override by setting process.env.HOME.
	const home = process.env.HOME ?? os.homedir();
	return path.join(home, ".wiki-viewer");
}

function hostedAppsJsonPath(): string {
	return path.join(wikiViewerDir(), "hosted-apps.json");
}

// ── Read / Write ──────────────────────────────────────────────────────────────

export async function readRegistry(): Promise<HostedAppsRegistry | null> {
	try {
		const raw = await readFile(hostedAppsJsonPath(), "utf8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		return {
			version: 1,
			apps: Array.isArray(parsed.apps) ? (parsed.apps as HostedApp[]) : [],
		};
	} catch {
		return null;
	}
}

/** Inner write — caller must already hold the mutex. */
async function _writeUnsafe(r: HostedAppsRegistry): Promise<void> {
	await mkdir(wikiViewerDir(), { recursive: true });
	const tmp = hostedAppsJsonPath() + ".tmp";
	await writeFile(tmp, JSON.stringify(r, null, 2), { encoding: "utf8", mode: 0o600 });
	try {
		await chmod(tmp, 0o600);
	} catch {
		// Non-fatal on some platforms.
	}
	await rename(tmp, hostedAppsJsonPath());
}

async function _ensureUnsafe(): Promise<HostedAppsRegistry> {
	const existing = await readRegistry();
	if (existing) return existing;
	const r: HostedAppsRegistry = { version: 1, apps: [] };
	await _writeUnsafe(r);
	return r;
}

// ── Queries ────────────────────────────────────────────────────────────────────

export async function listHostedApps(): Promise<HostedApp[]> {
	const r = await readRegistry();
	return r?.apps ?? [];
}

export async function getBySlug(slug: string): Promise<HostedApp | null> {
	const r = await readRegistry();
	if (!r) return null;
	return r.apps.find((a) => a.slug === slug) ?? null;
}

// ── Mutations ──────────────────────────────────────────────────────────────────

export type CreateHostedAppInput = {
	slug: string;
	type: HostedAppType;
	workspaceId: string;
	relPath: string;
	script?: string;
	persist?: boolean;
};

export type CreateResult =
	| { ok: true; app: HostedApp }
	| { ok: false; code: "SLUG_REQUIRED" | "SLUG_INVALID" | "SLUG_RESERVED" }
	| { ok: false; code: "SLUG_TAKEN"; ownerWorkspaceId: string };

/**
 * Create a hosted app. Validates slug format/reserved words and enforces global
 * uniqueness. On a duplicate slug the error reports the workspace that already
 * owns it (per the parent spec's duplicate-slug UX).
 */
export async function createHostedApp(input: CreateHostedAppInput): Promise<CreateResult> {
	const v = validateSlug(input.slug);
	if (!v.ok) return { ok: false, code: v.code };

	return withFileMutex(HOSTED_APPS_MUTEX_KEY, async (): Promise<CreateResult> => {
		const r = await _ensureUnsafe();
		const clash = r.apps.find((a) => a.slug === input.slug);
		if (clash) {
			return { ok: false, code: "SLUG_TAKEN", ownerWorkspaceId: clash.workspaceId };
		}
		const app: HostedApp = {
			slug: input.slug,
			type: input.type,
			workspaceId: input.workspaceId,
			relPath: input.relPath,
			...(input.type === "node" && input.script ? { script: input.script } : {}),
			...(input.type === "node" && input.persist ? { persist: true } : {}),
			createdAt: new Date().toISOString(),
		};
		r.apps.push(app);
		await _writeUnsafe(r);
		return { ok: true, app };
	});
}

export async function setHostedAppPersist(slug: string, persist: boolean): Promise<HostedApp | null> {
	return withFileMutex(HOSTED_APPS_MUTEX_KEY, async () => {
		const r = await readRegistry();
		if (!r) return null;
		const app = r.apps.find((candidate) => candidate.slug === slug);
		if (!app || app.type !== "node") return null;
		if (persist) app.persist = true;
		else delete app.persist;
		await _writeUnsafe(r);
		return app;
	});
}

export async function deleteHostedApp(slug: string): Promise<boolean> {
	return withFileMutex(HOSTED_APPS_MUTEX_KEY, async () => {
		const r = await readRegistry();
		if (!r) return false;
		const before = r.apps.length;
		r.apps = r.apps.filter((a) => a.slug !== slug);
		if (r.apps.length === before) return false;
		await _writeUnsafe(r);
		return true;
	});
}

/** True if the slug is free (and format/reserved-valid). */
export async function isSlugAvailable(slug: string): Promise<boolean> {
	if (!validateSlug(slug).ok) return false;
	return (await getBySlug(slug)) === null;
}
