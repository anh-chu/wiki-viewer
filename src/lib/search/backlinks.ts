/**
 * Demand-driven backlinks — ripgrep prefilter + parse verification.
 *
 * Old index: a persistent SQLite links table built by a recursive tree walk.
 * New strategy:
 *   1. rgLiteralSearch for the literal string "[[<slug>" (fixed-string).
 *   2. Verify each candidate by reading the file and running extractWikiLinks.
 *      This rejects rg false positives (e.g. [[foobar]] when target is "foo")
 *      and bracket-less mentions. Non-markdown files are skipped.
 *   3. Build a <mark>-wrapped snippet from the VERIFIED occurrence (not rg's
 *      match), so the highlight covers the entire [[target|alias]] span.
 *
 * One entry per source file regardless of occurrence count, in rg's ranking
 * order. Bounded concurrency (8). Stops scheduling new reads as soon as `limit`
 * verified results exist. Bail out promptly on AbortSignal.
 *
 * rg is a PREFILTER ONLY: every candidate it returns is verified by parsing,
 * with no cap below the rg prefilter limit — a run of prefix false positives
 * ([[foo-bar]] when the target is "foo") must never hide a genuine [[foo]]
 * that rg ranked further down the list.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { slugFromPath, extractWikiLinks } from "@/lib/markdown/wikilink";
import { rgLiteralSearch } from "@/lib/search/rg-search";
import { buildSnippet } from "@/lib/search/rg-snippet";

// ── Types ────────────────────────────────────────────────────────────────────

export interface Backlink {
	path: string;
	snippet: string;
}

export interface BacklinkResult {
	backlinks: Backlink[];
	/** Set when results may be incomplete (e.g. rg unavailable). */
	degraded?: string;
}

export interface BacklinkOptions {
	limit?: number;
	signal?: AbortSignal;
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const HARD_CAP = 200;
const RG_PREFILTER_LIMIT = 400;
const RG_TIMEOUT_MS = 5000;
const READ_CONCURRENCY = 8;
const MAX_READ_BYTES = 1_048_576; // 1 MiB

// ── Test seam ────────────────────────────────────────────────────────────────

/** File reader used by verification. Production always uses fs/promises. */
export type BacklinkReader = (absPath: string) => Promise<Buffer>;

let readFileImpl: BacklinkReader = (absPath) => readFile(absPath);

/**
 * Minimal seam for tests only.
 *
 * Verification runs 8 reads concurrently, so "never exceed limit" and "emit in
 * candidate order" only mean something when read completion is OUT OF candidate
 * order. Real filesystem reads usually finish in near-candidate order, so a
 * test using real files would pass without proving anything. Tests install a
 * reader with controlled delays instead.
 *
 * Pass null to restore the production reader.
 */
export function _setBacklinkReaderForTest(fn: BacklinkReader | null): void {
	readFileImpl = fn ?? ((absPath) => readFile(absPath));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function isMarkdownExt(p: string): boolean {
	const lower = p.toLowerCase();
	return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/** Compute byte offsets for the entire [[…]] span from a WikiLinkOccurrence. */
function wikilinkByteSpan(
	lineText: string,
	occ: { index: number },
): { start: number; end: number } {
	const closeIdx = lineText.indexOf("]]", occ.index);
	const spanEnd = closeIdx !== -1 ? closeIdx + 2 : lineText.length;
	const start = Buffer.byteLength(lineText.slice(0, occ.index));
	const end = start + Buffer.byteLength(lineText.slice(occ.index, spanEnd));
	return { start, end };
}

// ── Public ───────────────────────────────────────────────────────────────────

/**
 * Resolve backlinks for a target file.
 *
 * @param rootDir    Workspace root.
 * @param targetPath Workspace-relative path of the target file.
 * @param opts.limit Max verified backlinks (default 50, hard cap 200).
 * @param opts.signal AbortSignal for cancellation.
 */
export async function resolveBacklinks(
	rootDir: string,
	targetPath: string,
	opts: BacklinkOptions = {},
): Promise<BacklinkResult> {
	const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, HARD_CAP);
	const signal = opts.signal;

	// 1. Derive slug from target path.
	const slug = slugFromPath(targetPath);
	if (!slug) return { backlinks: [] };

	// 2. Prefilter with rg.
	const rgResult = await rgLiteralSearch(rootDir, "[[" + slug, {
		limit: RG_PREFILTER_LIMIT,
		timeoutMs: RG_TIMEOUT_MS,
		signal,
	});

	if (!rgResult.ok) {
		if (rgResult.reason === "unavailable") {
			return { backlinks: [], degraded: "rg-unavailable" };
		}
		const partial = rgResult.partialResults ?? [];
		return {
			backlinks: await verifyCandidates(rootDir, partial, slug, targetPath, limit, signal),
			degraded: rgResult.reason,
		};
	}

	return {
		backlinks: await verifyCandidates(rootDir, rgResult.results, slug, targetPath, limit, signal),
		degraded: rgResult.truncated ? "truncated" : undefined,
	};
}

// ── Verification ─────────────────────────────────────────────────────────────

interface Candidate {
	path: string;
}

async function verifyCandidates(
	rootDir: string,
	candidates: Candidate[],
	targetSlug: string,
	targetPath: string,
	limit: number,
	signal?: AbortSignal,
): Promise<Backlink[]> {
	// Filter: drop self-link, drop non-markdown, preserve rg order.
	//
	// NO pre-cap here. The candidate list is already bounded by the rg prefilter
	// limit (400) and concurrency is bounded at 8, so verifying all of them is
	// bounded work. Capping at a multiple of `limit` would let a run of prefix
	// false positives ([[foo-bar]] for target "foo") crowd out a genuine [[foo]]
	// that rg ranked later — exactly the case verification exists for.
	const filtered: string[] = [];
	for (const c of candidates) {
		if (c.path === targetPath) continue;
		if (!isMarkdownExt(c.path)) continue;
		filtered.push(c.path);
	}

	// Verified results keyed by CANDIDATE INDEX, so emission order is candidate
	// (rg ranking) order rather than read-completion order. Reads run 8-wide and
	// finish out of order, so an insertion-ordered array would scramble ranking.
	const found = new Map<number, Backlink>();
	let nextIndex = 0;
	let active = 0;
	let aborted = false;
	// Single settle flag: done() must be idempotent and no worker may mutate
	// `found` after the promise resolved.
	let settled = false;

	const onAbort = () => { aborted = true; };
	signal?.addEventListener("abort", onAbort, { once: true });

	return new Promise((resolve) => {
		const done = () => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			const ordered = [...found.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([, backlink]) => backlink);
			// slice() is belt-and-braces: pushes are already limit-gated.
			resolve(ordered.slice(0, limit));
		};

		const processNext = async () => {
			while (
				nextIndex < filtered.length &&
				found.size < limit &&
				!aborted &&
				!settled
			) {
				const idx = nextIndex++;
				const candidate = filtered[idx]!;
				active++;

				try {
					const backlink = await verifyOne(rootDir, candidate, targetSlug);
					// Re-check AFTER the await: while this read was in flight another
					// worker may have settled the promise or reached the limit. Without
					// this, up to READ_CONCURRENCY workers each pass the pre-await check
					// and then all push, overshooting `limit`.
					if (settled) return;
					if (backlink && found.size < limit) {
						found.set(idx, backlink);
						if (found.size >= limit) {
							done();
							return;
						}
					}
				} catch {
					// Skip read errors (permission, missing, etc.)
				} finally {
					active--;
				}
			}

			if (active === 0) done();
		};

		// No candidates at all is the common case (a file nothing links to).
		// Without this guard, workers === 0 means processNext is never called,
		// done() never runs, and the promise never settles — the request hangs.
		if (filtered.length === 0) {
			done();
			return;
		}

		const workers = Math.min(READ_CONCURRENCY, filtered.length);
		for (let w = 0; w < workers; w++) processNext();
	});
}

/** Exported for tests only — see _setBacklinkReaderForTest. */
export const _verifyCandidatesForTest = verifyCandidates;

async function verifyOne(
	rootDir: string,
	candidate: string,
	targetSlug: string,
): Promise<Backlink | null> {
	const absPath = path.join(rootDir, candidate);

	let text: string;
	try {
		const buf = await readFileImpl(absPath);
		text = buf.subarray(0, Math.min(buf.length, MAX_READ_BYTES)).toString("utf8");
	} catch {
		return null;
	}

	const occurrences = extractWikiLinks(text);
	const match = occurrences.find((o) => o.slug === targetSlug);
	if (!match) return null;

	const span = wikilinkByteSpan(match.lineText, match);
	const snippet = buildSnippet(match.lineText, [span], { window: 80 });

	return { path: candidate, snippet };
}
