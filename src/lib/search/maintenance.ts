/**
 * Startup and periodic hygiene for search.db.
 *
 * - pruneStaleWorkspaces removes rows for workspace ids absent from the registry
 *   and for ephemeral (ws_eph_*) ids that never enter config.json.
 * - reclaimPages runs a bounded PRAGMA incremental_vacuum to return free pages.
 * - runStartupMaintenance composes both and runs once per process.
 *
 * All operations are designed to not block the event loop: deletion is one
 * workspace per transaction with a setImmediate yield between workspaces.
 */
import { getSearchDb } from "./search-db";

let _runOnce = false;

/**
 * Delete rows belonging to workspace ids not in `knownIds` or prefixed `ws_eph_`.
 * Runs one workspace per transaction, yielding between each.
 * Returns a summary of what was removed.
 */
export async function pruneStaleWorkspaces(
	knownIds: Set<string>,
): Promise<{ workspacesRemoved: number; rowsRemoved: number }> {
	const db = getSearchDb();

	// Collect all distinct workspace ids that appear in the database.
	const wsRows = db.prepare(
		`SELECT DISTINCT ws FROM files UNION SELECT DISTINCT ws FROM links`,
	).all() as Array<{ ws: string }>;

	const toRemove: string[] = [];
	for (const { ws } of wsRows) {
		if (!knownIds.has(ws) || ws.startsWith("ws_eph_")) {
			toRemove.push(ws);
		}
	}

	if (toRemove.length === 0) return { workspacesRemoved: 0, rowsRemoved: 0 };

	let rowsRemoved = 0;

	for (const ws of toRemove) {
		const info = db.transaction(() => {
			const a = db.prepare(`DELETE FROM files WHERE ws = ?`).run(ws);
			const b = db.prepare(`DELETE FROM links WHERE ws = ?`).run(ws);
			return a.changes + b.changes;
		})();
		rowsRemoved += info;
		// Yield the event loop between workspaces.
		await new Promise<void>((r) => setImmediate(r));
	}

	console.log(
		`[maintenance] pruned ${toRemove.length} stale workspace(s), ${rowsRemoved} rows removed`,
	);

	return { workspacesRemoved: toRemove.length, rowsRemoved };
}

/**
 * Reclaim free pages via incremental_vacuum.
 * Bounded per call so a single large database never blocks for long.
 * Returns the number of pages freed (0 if auto_vacuum is not INCREMENTAL).
 */
export function reclaimPages(pageBudget: number = 2000): number {
	const db = getSearchDb();
	const before = db.pragma("freelist_count", { simple: true }) as number;
	if (before <= 0) return 0;

	const pages = Math.min(pageBudget, before);
	db.pragma("incremental_vacuum(" + pages + ")");

	const after = db.pragma("freelist_count", { simple: true }) as number;
	return before - after;
}

/**
 * Run one-off startup maintenance: prune stale workspaces and reclaim pages.
 * Guards so it runs at most once per process. Any failure logs and does not
 * propagate — maintenance must never prevent the server from booting.
 */
export async function runStartupMaintenance(): Promise<void> {
	if (_runOnce) return;
	_runOnce = true;

	try {
		// Dynamic import to avoid circular dependency: workspaces.ts imports
		// indexer.ts (via purgeWorkspace), so we cannot import listWorkspaces
		// at the top level.
		const { listWorkspaces } = await import("../workspaces");
		const workspaces = await listWorkspaces();
		const knownIds = new Set(workspaces.map((w) => w.id));

		const { workspacesRemoved, rowsRemoved } = await pruneStaleWorkspaces(knownIds);
		if (rowsRemoved > 0 || workspacesRemoved > 0) {
			reclaimPages();
		}
	} catch (e) {
		console.error("[maintenance] startup maintenance error (non-fatal)", e);
	}
}
