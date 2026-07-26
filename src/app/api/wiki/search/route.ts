export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth/csrf";
import { resolveWorkspaceForUser } from "@/lib/workspace-context";
import { searchFilenames } from "@/lib/search/filename-search";
import { rgLiteralSearch } from "@/lib/search/rg-search";


const HARD_LIMIT = 200;

export async function POST(request: Request) {
	const csrf = checkOrigin(request);
	if (csrf) return csrf;

	const ctx = await resolveWorkspaceForUser(request);
	if (!ctx.ok) return NextResponse.json({ error: ctx.code }, { status: ctx.status });

	let body: { query?: unknown; limit?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return NextResponse.json({ error: "INVALID_PAYLOAD" }, { status: 400 });
	}

	const query = typeof body.query === "string" ? body.query : "";
	const limit = Math.min(
		typeof body.limit === "number" ? body.limit : 30,
		HARD_LIMIT,
	);

	// Empty query short-circuits without spawning anything.
	if (!query.trim()) {
		return NextResponse.json({
			kind: "rg",
			query,
			matches: [],
			truncated: false,
		});
	}

	// Run content and filename searches concurrently. Both are demand-driven
	// rg invocations; nothing is indexed or warmed up.
	// rootIsHazardMount is handled inside rgLiteralSearch (buildPrefixArgs).
	const [rgResult, fnResult] = await Promise.all([
		rgLiteralSearch(ctx.rootDir, query, {
			limit,
			timeoutMs: 10_000,
			signal: request.signal,
		}),
		searchFilenames(ctx.rootDir, query, limit, { signal: request.signal }),
	]);

	// Build filename hit set for dedup.
	const fnPathSet = new Set(fnResult.paths);

	const matches: Array<{
		path: string;
		score: number;
		snippet: string;
		line?: number;
	}> = [];

	// Filename matches first (strongest signal — matches old FTS name column).
	for (const fnPath of fnResult.paths) {
		matches.push({
			path: fnPath,
			score: 2000, // filename hit gets top score
			snippet: "",
		});
	}

	// Content matches follow, skipping files already in the filename set.
	if (rgResult.ok) {
		for (const hit of rgResult.results) {
			if (fnPathSet.has(hit.path)) continue;
			matches.push({
				path: hit.path,
				score: hit.score,
				snippet: hit.firstMatch.snippet,
				line: hit.firstMatch.line,
			});
		}
	} else if (rgResult.reason === "unavailable") {
		// Degraded mode: filename-only results.
	} else if (rgResult.partialResults) {
		// Timeout or error with partial results.
		for (const hit of rgResult.partialResults) {
			if (fnPathSet.has(hit.path)) continue;
			matches.push({
				path: hit.path,
				score: hit.score,
				snippet: hit.firstMatch.snippet,
				line: hit.firstMatch.line,
			});
		}
	}

	// Truncated if EITHER leg truncated.
	const truncated = (rgResult.ok ? rgResult.truncated : true) || fnResult.truncated;

	const finalMatches = matches.slice(0, limit);

	const response: Record<string, unknown> = {
		kind: "rg",
		query,
		matches: finalMatches,
		truncated,
	};

	if (!rgResult.ok && rgResult.reason === "unavailable") {
		response.degraded = "rg-unavailable";
	}

	return NextResponse.json(response);
}
