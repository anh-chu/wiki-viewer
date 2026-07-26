/**
 * Demand-driven filename search — replaces a SQL LIKE query over an indexed
 * files table.
 *
 * Invariant: FILE_LIST_LIMIT must stay at least 100× any result limit (callers
 * cap at 200). This ensures the token filter is not starved by rg being killed
 * at the cap before enough candidate paths are collected.
 */
import { rgListFiles } from "@/lib/search/rg-search";

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Maximum number of files to list from rg. Must stay ≥ 100× caller result
 * limits (callers cap at 200, so 100 × 200 = 20_000).
 */
export const FILE_LIST_LIMIT = 20_000;

const RG_TIMEOUT_MS = 5000;

// ── Types ────────────────────────────────────────────────────────────────────

export interface FilenameSearchResult {
	paths: string[];
	truncated: boolean;
	/** Set when results may be incomplete (e.g. rg unavailable). */
	degraded?: string;
}

export interface FilenameSearchOptions {
	signal?: AbortSignal;
}

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * List workspace files whose paths contain every token of `query`.
 *
 * Calls rg --files, then filters in JS: trim, split on whitespace (max 8),
 * lowercase, EVERY token must be a substring of the lowercased relative path.
 * Results are sliced to `limit`.
 *
 * @param rootDir Workspace root.
 * @param query   Space-separated tokens (max 8).
 * @param limit   Max results to return (callers cap at 200).
 */
export async function searchFilenames(
	rootDir: string,
	query: string,
	limit: number,
	opts: FilenameSearchOptions = {},
): Promise<FilenameSearchResult> {
	const trimmed = query.trim();
	if (!trimmed) return { paths: [], truncated: false };

	const tokens = trimmed.split(/\s+/).slice(0, 8).map((t) => t.toLowerCase());
	if (tokens.length === 0) return { paths: [], truncated: false };

	const rgResult = await rgListFiles(rootDir, {
		limit: FILE_LIST_LIMIT,
		timeoutMs: RG_TIMEOUT_MS,
		signal: opts.signal,
	});

	if (!rgResult.ok) {
		if (rgResult.reason === "unavailable") {
			return { paths: [], truncated: false, degraded: "rg-unavailable" };
		}
		// Timeout or error — filter partial results if any.
		const partial = rgResult.partialResults ?? [];
		const filtered = filterByTokens(partial, tokens, limit);
		return { paths: filtered.results, truncated: true, degraded: rgResult.reason };
	}

	const filtered = filterByTokens(rgResult.results, tokens, limit);
	return {
		paths: filtered.results,
		truncated: rgResult.truncated || filtered.truncated,
	};
}

// ── Internal ─────────────────────────────────────────────────────────────────

function filterByTokens(
	paths: string[],
	tokens: string[],
	limit: number,
): { results: string[]; truncated: boolean } {
	const results: string[] = [];
	for (const p of paths) {
		const lower = p.toLowerCase();
		if (tokens.every((t) => lower.includes(t))) {
			results.push(p);
			if (results.length >= limit) {
				return { results, truncated: true };
			}
		}
	}
	return { results, truncated: false };
}
