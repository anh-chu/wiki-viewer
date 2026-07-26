export const runtime = "nodejs";

import path from "node:path";
import { statSync, realpathSync } from "node:fs";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { subscribe } from "@/lib/search/watcher-pool";
import { isDeniedRelPath } from "@/lib/proof/raw-fs";

/** Hard cap on watch scopes per SSE connection (client caps at 24 too). */
export const MAX_WATCH_DIRS = 24;

/**
 * Window in which the SAME (type, workspace-relative path) reported by a
 * DIFFERENT overlapping scope is treated as one physical event.
 */
const DEDUP_WINDOW_MS = 250;

/** Bound on the dedup map so a long-lived stream cannot grow without limit. */
const DEDUP_MAX_KEYS = 1024;

/**
 * Decide which absolute directories an SSE connection watches.
 *
 * Pure and auth-free so it can be unit-tested with a bare URL string.
 *
 * The workspace ROOT is ALWAYS included and always first, so a request with no
 * `dir` params (or an old client) still receives root-level events and can
 * never provoke a recursive watch.
 *
 * A requested `dir` is accepted only when it is:
 *   - not absolute,
 *   - inside the root after path.normalize (no ".." escape),
 *   - not denied by isDeniedRelPath,
 *   - not a duplicate of an already accepted scope (the empty string normalises
 *     to the root and is therefore always a duplicate of it),
 *   - an existing directory (statSync guard), so chokidar is never armed on a
 *     phantom path,
 *   - REAL-PATH contained in the workspace. The lexical checks are not enough:
 *     a workspace may contain `outside -> /elsewhere`, which passes lexical
 *     containment and statSync, and subscribe() realpaths internally — so
 *     chokidar would watch /elsewhere while events were re-prefixed as
 *     `outside/...`. The realpath check also stops a symlinked scope from
 *     colliding with pool entries keyed by the real path.
 *
 * Reads REPEATED `dir` params with getAll — reading only get("dir") would watch
 * a single directory and leave the rest of the expanded tree dead.
 *
 * Request order is preserved; the cap is applied AFTER dedupe.
 */
export function resolveWatchScopes(requestUrl: string, rootDir: string): string[] {
	const params = new URL(requestUrl).searchParams;

	// Root scope first, unconditionally.
	const acceptedRel = new Set<string>([""]);
	const abs: string[] = [rootDir];

	// Real path of the root — every accepted scope must resolve inside it.
	let rootReal: string;
	try {
		rootReal = realpathSync(rootDir);
	} catch {
		rootReal = path.resolve(rootDir);
	}

	for (const raw of params.getAll("dir")) {
		if (abs.length >= MAX_WATCH_DIRS) break;
		if (typeof raw !== "string") continue;
		if (path.isAbsolute(raw)) continue;

		// Normalise, then canonicalise "" / "." / trailing slash to the root.
		let rel = path.normalize(raw);
		if (rel === "." || rel === "./" || rel === path.sep) rel = "";
		rel = rel.replace(/[\\/]+$/, "");

		// Escapes the root?
		if (rel === ".." || rel.startsWith(".." + path.sep) || rel.startsWith("../")) continue;
		if (rel !== "" && isDeniedRelPath(rel)) continue;

		// Duplicate (the empty string is the root, already accepted).
		if (acceptedRel.has(rel)) continue;

		const absDir = path.resolve(rootDir, rel);
		// Belt-and-braces containment check after resolve.
		if (absDir !== rootDir && !absDir.startsWith(rootDir + path.sep)) continue;

		// Must exist and be a directory — never arm a watcher on a phantom path.
		try {
			if (!statSync(absDir).isDirectory()) continue;
		} catch {
			continue;
		}

		// Symlink scope escape: resolve and require REAL containment. Only after
		// this passes is the LEXICAL rel path usable as the event prefix.
		try {
			const real = realpathSync(absDir);
			if (real !== rootReal && !real.startsWith(rootReal + path.sep)) continue;
		} catch {
			continue;
		}

		acceptedRel.add(rel);
		abs.push(absDir);
	}

	return abs;
}

/**
 * Workspace-relative prefix for a scope ("" for the root scope).
 *
 * Always POSIX-separated: clients index the file tree by "a/b" keys.
 */
export function scopePrefix(rootDir: string, absDir: string): string {
	if (absDir === rootDir) return "";
	return path.relative(rootDir, absDir).split(path.sep).join("/");
}

/**
 * CONTRACT: the pool rebases each event against ITS OWN watch root, but clients
 * expect WORKSPACE-relative paths. A scope at `child/dir` reporting `a.md` must
 * reach the client as `child/dir/a.md`; root-scope events stay unprefixed.
 */
export function applyScopePrefix(relPrefix: string, relPath: string): string {
	if (!relPrefix) return relPath;
	return relPath ? `${relPrefix}/${relPath}` : relPrefix;
}

/**
 * Overlap suppression ACROSS scopes.
 *
 * The root scope and an expanded subdirectory scope can both report the same
 * physical file event, so the client would see it twice. Only that is worth
 * suppressing: a repeated event from the SAME scope is a genuine second event
 * (e.g. two saves in quick succession) and must always pass through. The pool
 * already batches at 200 ms; a second blanket time window here would silently
 * drop real changes.
 */
export function createOverlapGate(
	windowMs: number = DEDUP_WINDOW_MS,
	maxKeys: number = DEDUP_MAX_KEYS,
) {
	const recent = new Map<string, { at: number; scope: string }>();

	return {
		/** True when the event should be delivered. */
		allow(type: string, wsRel: string, scope: string, now: number = Date.now()): boolean {
			const key = `${type}\u0000${wsRel}`;
			const last = recent.get(key);
			// Same key, still inside the window, reported by a DIFFERENT scope: the
			// duplicate half of one physical event. Drop it and keep the original
			// timestamp so the window cannot be extended indefinitely.
			if (last !== undefined && now - last.at < windowMs && last.scope !== scope) {
				return false;
			}
			if (recent.size >= maxKeys) {
				for (const [k, v] of recent) {
					if (now - v.at >= windowMs) recent.delete(k);
				}
				if (recent.size >= maxKeys) recent.clear();
			}
			recent.set(key, { at: now, scope });
			return true;
		},
		clear() {
			recent.clear();
		},
		size() {
			return recent.size;
		},
	};
}

export async function GET(request: Request) {
	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return new Response(ctx.code, { status: ctx.status });
	const { ws, rootDir } = ctx;

	const scopes = resolveWatchScopes(request.url, rootDir);

	const encoder = new TextEncoder();
	const unsubscribers: Array<() => void> = [];
	let heartbeatId: ReturnType<typeof setInterval> | null = null;
	let controllerRef: ReadableStreamDefaultController | null = null;
	let closed = false;

	const gate = createOverlapGate();

	function send(data: object) {
		if (!controllerRef) return;
		try {
			controllerRef.enqueue(
				encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
			);
		} catch {
			// stream closed
		}
	}

	function teardown() {
		if (heartbeatId !== null) {
			clearInterval(heartbeatId);
			heartbeatId = null;
		}
		while (unsubscribers.length > 0) {
			const unsub = unsubscribers.pop();
			try {
				unsub?.();
			} catch {
				// pool teardown must never throw into the stream
			}
		}
		gate.clear();
	}

	/**
	 * Deliberate recovery path: the pool downgraded to a degraded/rescan state.
	 * Tell the client, drop every listener (which evicts the degraded pool entry)
	 * and close the stream. Native EventSource reconnect then builds a fresh
	 * watcher. Never swallowed.
	 */
	function handleRescan() {
		if (closed) return;
		closed = true;
		send({ type: "rescan", path: "" });
		teardown();
		const c = controllerRef;
		controllerRef = null;
		try {
			c?.close();
		} catch {
			// already closed
		}
	}

	const stream = new ReadableStream({
		start(controller) {
			controllerRef = controller;

			for (const absDir of scopes) {
				// Workspace-relative prefix for this scope ("" for the root scope).
				const relPrefix = scopePrefix(rootDir, absDir);

				// depth: 0 — one level only. The pool never watches recursively here.
				const unsub = subscribe(
					ws.id,
					absDir,
					(type, relPath) => {
						if (type === "rescan") {
							handleRescan();
							return;
						}
						if (closed) return;

						const wsRel = applyScopePrefix(relPrefix, relPath);

						// Suppress only the duplicate arriving from another overlapping
						// scope; repeated events from this scope always pass.
						if (!gate.allow(type, wsRel, absDir)) return;

						send({ type, path: wsRel });
					},
					{ depth: 0 },
				);
				unsubscribers.push(unsub);
			}

			// Heartbeat keeps the connection alive through proxies / load balancers.
			heartbeatId = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(": heartbeat\n\n"));
				} catch {
					if (heartbeatId !== null) clearInterval(heartbeatId);
				}
			}, 15_000);
		},

		cancel() {
			closed = true;
			controllerRef = null;
			teardown();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}
