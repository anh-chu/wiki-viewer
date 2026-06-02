/**
 * Better Auth server instance.
 * Supports: email+password, Google OAuth (optional).
 * DB: SQLite at ~/.wiki-viewer/auth.db (WAL mode).
 */
import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isEmailAllowed } from "./allowlist";

// Guard runs at server startup, not during next build (NEXT_PHASE=phase-production-build).
// Set WIKI_ALLOW_INSECURE=1 to bypass the https requirement (development / CI / smoke tests).
if (
	process.env.NODE_ENV === "production" &&
	process.env.NEXT_PHASE !== "phase-production-build" &&
	process.env.WIKI_ALLOW_INSECURE !== "1"
) {
	const url = process.env.BETTER_AUTH_URL ?? "";
	if (!url) {
		throw new Error(
			"BETTER_AUTH_URL is required in production. Set it to https://your-domain so cookies and OAuth callbacks resolve correctly. Set WIKI_ALLOW_INSECURE=1 to bypass (development only).",
		);
	}
	if (!url.startsWith("https://")) {
		throw new Error(
			`BETTER_AUTH_URL must be https:// in production (got: ${url}). Set WIKI_ALLOW_INSECURE=1 to bypass (development only).`,
		);
	}
}

const DATA_DIR = path.join(process.env.HOME ?? os.homedir(), ".wiki-viewer");
mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, "auth.db");
const SECRET_PATH = path.join(DATA_DIR, "auth.secret");

function resolveSecret(): string {
	if (process.env.BETTER_AUTH_SECRET) return process.env.BETTER_AUTH_SECRET;
	if (existsSync(SECRET_PATH)) {
		return readFileSync(SECRET_PATH, "utf-8").trim();
	}
	const fresh = randomBytes(32).toString("base64");
	writeFileSync(SECRET_PATH, fresh, { mode: 0o600 });
	try {
		chmodSync(SECRET_PATH, 0o600);
	} catch {
		// chmod best-effort on platforms that support it
	}
	return fresh;
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

function getTrustedOrigins(): string[] {
	const extra = (process.env.WIKI_OWNER_HOSTS ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean);
	const ports = ["", ":3000", ":3003"];
	const base = ["http://localhost:3000", "http://localhost:3003"];
	const extras = extra.flatMap((h) =>
		ports.flatMap((p) => [`http://${h}${p}`, `https://${h}${p}`]),
	);
	return Array.from(new Set([...base, ...extras]));
}

const socialProviders: Record<string, unknown> = {};
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
	socialProviders.google = {
		clientId: process.env.GOOGLE_CLIENT_ID,
		clientSecret: process.env.GOOGLE_CLIENT_SECRET,
	};
}

export const auth = betterAuth({
	database: db,
	secret: resolveSecret(),
	baseURL: process.env.BETTER_AUTH_URL,
	emailAndPassword: {
		enabled: true,
		requireEmailVerification: false,
		autoSignIn: true,
	},
	// Loosen Better Auth's default 3-per-10-seconds limit on /sign-in/email
	// so a single bad password doesn't lock the user out for the window.
	// Per-user lockout is not implemented (Better Auth rate-limits by IP).
	rateLimit: {
		enabled: process.env.NODE_ENV === "production",
		window: 60,
		max: 100,
		customRules: {
			"/sign-in/email": { window: 60, max: 20 },
			"/sign-up/email": { window: 60, max: 10 },
		},
	},
	socialProviders,
	databaseHooks: {
		user: {
			create: {
				before: async (user: { email: string }) => {
					if (!(await isEmailAllowed(user.email))) {
						throw new Error("SIGNUP_NOT_ALLOWED");
					}
					return { data: user };
				},
			},
		},
	},
	plugins: [nextCookies()],
	trustedOrigins: getTrustedOrigins(),
});

// Auto-migrate tables on first import. Idempotent: re-runs are no-ops once schema matches.
// Exposed as a Promise so consumers can await readiness before issuing auth calls.
const MIGRATED_PROMISE_KEY = Symbol.for("wiki-viewer.better-auth.migration-promise");
interface GlobalWithPromise {
	[k: symbol]: Promise<void> | undefined;
}
const g = globalThis as unknown as GlobalWithPromise;
if (!g[MIGRATED_PROMISE_KEY]) {
	g[MIGRATED_PROMISE_KEY] = (async () => {
		const mod = (await import("better-auth/db/migration")) as {
			getMigrations: (opts: unknown) => Promise<{ runMigrations: () => Promise<void> }>;
		};
		const { runMigrations } = await mod.getMigrations(
			(auth as unknown as { options: unknown }).options,
		);
		await runMigrations();
	})();
}

/** Await this in tests / one-shot scripts before calling auth.api.*. */
export function authReady(): Promise<void> {
	return g[MIGRATED_PROMISE_KEY] ?? Promise.resolve();
}

export interface SessionUser {
	id: string;
	email: string;
	name: string;
}

export async function getSessionFromRequest(req: Request) {
	return auth.api.getSession({ headers: req.headers });
}

export async function requireUser(
	req: Request,
): Promise<{ ok: true; user: SessionUser } | { ok: false }> {
	const session = await getSessionFromRequest(req);
	if (!session?.user) return { ok: false };
	return {
		ok: true,
		user: {
			id: session.user.id,
			email: session.user.email,
			name: session.user.name,
		},
	};
}
