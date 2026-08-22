/**
 * Ripgrep content-search engine.
 *
 * Spawns a per-query ripgrep child process with an argument array (never a
 * shell). Streams `--json` NDJSON from stdout, enforces caps by killing the
 * child, and returns structured results.
 *
 * Conventions mirror src/lib/sshfs.ts (arg array, stderr collected, timer-driven
 * kill) and src/lib/git.ts (explicit env, cached availability probe).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { resolveRgPath } from "./rg-path";
import { buildSnippet, type RgSubmatch } from "./rg-snippet";
import { isDeniedRelPath } from "@/lib/proof/raw-fs";

// ── Lazy mount imports (Group 2 — may not exist yet) ─────────────────────────

interface MountsApi {
	nestedHazardMounts(rootDir: string): string[];
	rootIsHazardMount(rootDir: string): boolean;
}

let _mountsModule: MountsApi | null = null;

async function loadMounts(): Promise<MountsApi> {
	if (_mountsModule) return _mountsModule;
	try {
		const mod = await import("@/lib/fs/mounts");
		_mountsModule = mod as MountsApi;
		return mod as MountsApi;
	} catch {
		_mountsModule = {
			nestedHazardMounts: () => [],
			rootIsHazardMount: () => false,
		};
		return _mountsModule;
	}
}

// ── Types ────────────────────────────────────────────────────────────────────

export interface RgMatch {
	path: string;
	line: number;
	col: number;
	text: string;
	snippet: string;
}

export interface RgFileHit {
	path: string;
	matchCount: number;
	tokensMatched: number;
	score: number;
	firstMatch: RgMatch;
}

export interface RgLineHit {
	path: string;
	line: number;
	col: number;
	text: string;
}

export interface RgOptions {
	limit?: number;
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Restrict search to a subdirectory (relative to rootDir). */
	startPath?: string;
}

export type RgOutcome<T> =
	| { ok: true; results: T; truncated: boolean }
	| {
			ok: false;
			reason: "unavailable" | "timeout" | "invalid-pattern" | "error";
			message: string;
			partialResults?: T;
	  };

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALWAYS_EXCLUDED = [".git", ".pi", ".proof", "node_modules", ".next"];

async function exclusionGlobs(rootDir: string): Promise<string[]> {
	const globs: string[] = [];
	for (const d of ALWAYS_EXCLUDED) {
		globs.push("--glob", `!${d}/**`);
	}
	const mounts = await loadMounts();
	const hazards = mounts.nestedHazardMounts(rootDir);
	for (const abs of hazards) {
		let rel = path.relative(rootDir, abs);
		if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
			rel = rel.replace(/\\/g, "/");
			globs.push("--glob", `!${rel}/**`);
		}
	}
	return globs;
}

/** Build the fixed prefix args common to every rg invocation. Does NOT include -- or paths. */
async function buildPrefixArgs(rootDir: string): Promise<string[]> {
	const args = [
		"--json",
		"--no-config",
		"--no-messages",
		"--no-follow",
		"--hidden",
		"--no-ignore",
		"--max-filesize", "2M",
		"--crlf",
	];
	const mounts = await loadMounts();
	if (mounts.rootIsHazardMount(rootDir)) {
		args.push("--no-mmap");
	}
	args.push(...(await exclusionGlobs(rootDir)));
	// Canvas scene JSON is embedded/binary data, not searchable prose. Exclude it
	// from full-text CONTENT search only (buildPrefixArgs feeds rgLiteralSearch /
	// rgRegexSearch); rgListFiles/filename search still lists .excalidraw.
	args.push("--glob", "!*.excalidraw");
	return args;
}

function safeRelPath(raw: string): string | null {
	let p = raw.replace(/\\/g, "/");
	if (path.isAbsolute(p)) return null;
	p = path.normalize(p).replace(/\\/g, "/");
	if (p.startsWith("..")) return null;
	if (p === ".") return null;
	if (isDeniedRelPath(p)) return null;
	return p;
}

// ── NDJSON event types ───────────────────────────────────────────────────────

interface RgJsonBegin {
	type: "begin";
	data: { path: { text: string } };
}
interface RgJsonMatch {
	type: "match";
	data: {
		path: { text: string };
		lines: { text: string };
		line_number: number;
		submatches: Array<{
			match: { text: string };
			start: number;
			end: number;
		}>;
	};
}
type RgJsonLine = RgJsonBegin | RgJsonMatch | { type: string; data?: unknown };

// ── Spawn + NDJSON stream ────────────────────────────────────────────────────

interface StreamOpts {
	timeoutMs: number;
	signal?: AbortSignal;
}

interface StreamResult {
	outcome: "success" | "timeout" | "error" | "aborted";
	code: number | null;
	stderr: string;
	truncated: boolean;
}

function killLadder(child: ChildProcess): void {
	try { child.kill("SIGTERM"); } catch { /* dead */ }
	setTimeout(() => {
		try { child.kill("SIGKILL"); } catch { /* dead */ }
	}, 2000);
}

/**
 * Spawn rg and stream NDJSON. Calls `onLine` for each parsed line (and returns
 * "cap" to kill early), `onPlainLine` for --files mode (plain-text output),
 * and returns a summary when the child exits.
 */
function spawnRgStream(
	rgPath: string,
	args: string[],
	cwd: string,
	jsonMode: boolean,
	opts: StreamOpts,
	onLine: (line: RgJsonLine) => "cap" | "continue",
	onPlainLine?: (line: string) => "cap" | "continue",
): Promise<StreamResult> {
	return new Promise((resolve) => {
		// If the signal was already aborted before we even spawn the child,
		// resolve immediately without spawning.
		if (opts.signal?.aborted) {
			resolve({ outcome: "aborted", code: null, stderr: "", truncated: true });
			return;
		}

		const child = spawn(rgPath, args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, RIPGREP_CONFIG_PATH: "" },
		});

		let stdout = "";
		let stderr = "";
		let resolved = false;
		let truncated = false;
		let exitCode: number | null = null;

		const finish = (outcome: StreamResult["outcome"]) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ outcome, code: exitCode, stderr, truncated });
		};

		const timer = setTimeout(() => {
			truncated = true;
			killLadder(child);
			finish("timeout");
		}, opts.timeoutMs);

		const signal = opts.signal;
		const onAbort = () => {
			truncated = true;
			killLadder(child);
			finish("aborted");
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			if (jsonMode) {
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const l of lines) {
					if (!l.trim()) continue;
					let parsed: RgJsonLine;
					try {
						parsed = JSON.parse(l) as RgJsonLine;
					} catch {
						continue; // skip malformed
					}
					if (onLine(parsed) === "cap") {
						truncated = true;
						killLadder(child);
						finish("success");
						return;
					}
				}
			} else if (onPlainLine) {
				const lines = stdout.split("\n");
				stdout = lines.pop() ?? "";
				for (const l of lines) {
					if (!l) continue;
					if (onPlainLine(l) === "cap") {
						truncated = true;
						killLadder(child);
						finish("success");
						return;
					}
				}
			}
		});

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});

		child.on("error", (err) => {
			exitCode = -1;
			stderr = err.message;
			finish("error");
		});

		child.on("close", (code) => {
			exitCode = code;
			if (resolved) return;

			// Process trailing partial line
			if (jsonMode && stdout.trim()) {
				try {
					const parsed = JSON.parse(stdout.trim()) as RgJsonLine;
					onLine(parsed);
				} catch { /* ignore */ }
			} else if (!jsonMode && onPlainLine && stdout) {
				onPlainLine(stdout);
			}

			if (code === 0 || code === 1) {
				finish("success");
			} else {
				finish("error");
			}
		});
	});
}

// ── rgLiteralSearch ──────────────────────────────────────────────────────────

/**
 * Tokenise query on whitespace (max 8), strip trailing `*`. Each token becomes
 * a `-e <token>` with --fixed-strings --ignore-case. A file qualifies ONLY if
 * every token matched somewhere in it (FTS5 AND semantics). Ranked by
 * (tokens matched desc, match count desc, path asc).
 */
export async function rgLiteralSearch(
	rootDir: string,
	query: string,
	opts: RgOptions = {},
): Promise<RgOutcome<RgFileHit[]>> {
	const trimmed = query.trim();
	if (!trimmed) {
		return { ok: true, results: [], truncated: false };
	}

	const rawTokens = trimmed.split(/\s+/).slice(0, 8);
	const tokens = rawTokens.map((t) => (t.endsWith("*") ? t.slice(0, -1) : t));
	if (tokens.length === 0) {
		return { ok: true, results: [], truncated: false };
	}

	const rgPath = await resolveRgPath();
	if (!rgPath) {
		return { ok: false, reason: "unavailable", message: "ripgrep binary not found" };
	}

	// Per-file state
	const fileMap = new Map<
		string,
		{ path: string; matches: RgMatch[]; tokenSet: Set<number> }
	>();
	const limit = opts.limit ?? 200;
	let matchCount = 0;

	const args = await buildPrefixArgs(rootDir);
	args.push("--fixed-strings", "--ignore-case");
	for (const token of tokens) {
		args.push("-e", token);
	}
	args.push("--", opts.startPath ?? ".");

	const streamOpts: StreamOpts = {
		timeoutMs: opts.timeoutMs ?? 10000,
		signal: opts.signal,
	};

	const streamResult = await spawnRgStream(
		rgPath,
		args,
		rootDir,
		true,
		streamOpts,
		(line) => {
			if (line.type !== "match") return "continue";
			const d = (line as RgJsonMatch).data;
			if (!d) return "continue";

			const safe = safeRelPath(d.path.text);
			if (!safe) return "continue";

			const submatches: RgSubmatch[] = (d.submatches ?? []).map((s) => ({
				start: s.start,
				end: s.end,
			}));

			const cleanLine = d.lines.text.replace(/\r?\n$/, "");
			const snippet = buildSnippet(cleanLine, submatches);
			const match: RgMatch = {
				path: safe,
				line: d.line_number,
				col: submatches[0]?.start != null ? submatches[0].start + 1 : 1,
				text: cleanLine,
				snippet,
			};

			const lowerLine = match.text.toLowerCase();
			const matchedIndices = new Set<number>();
			for (let i = 0; i < tokens.length; i++) {
				if (lowerLine.includes(tokens[i]!.toLowerCase())) {
					matchedIndices.add(i);
				}
			}

			let file = fileMap.get(safe);
			if (!file) {
				file = { path: safe, matches: [], tokenSet: new Set() };
				fileMap.set(safe, file);
			}
			for (const idx of matchedIndices) file.tokenSet.add(idx);
			file.matches.push(match);
			matchCount++;

			if (matchCount >= limit) return "cap";
			return "continue";
		},
	);

	// Build results: only files where every token matched
	const allTokens = tokens.length;
	const hits: RgFileHit[] = [];
	for (const file of fileMap.values()) {
		if (file.tokenSet.size < allTokens) continue;
		const sorted = file.matches.sort((a, b) => a.line - b.line);
		const firstMatch = sorted[0]!;
		const score =
			(file.tokenSet.size / allTokens) * 1000 +
			Math.min(file.matches.length, 100);
		hits.push({
			path: file.path,
			matchCount: file.matches.length,
			tokensMatched: file.tokenSet.size,
			score,
			firstMatch,
		});
	}

	hits.sort((a, b) => {
		if (b.tokensMatched !== a.tokensMatched) return b.tokensMatched - a.tokensMatched;
		if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
		return a.path.localeCompare(b.path);
	});

	if (streamResult.outcome === "success") {
		if (streamResult.code === 2) {
			return {
				ok: false,
				reason: "error",
				message: streamResult.stderr.trim().split("\n")[0] ?? "rg error",
				partialResults: hits,
			};
		}
		return { ok: true, results: hits, truncated: streamResult.truncated };
	}

	if (streamResult.outcome === "timeout") {
		return {
			ok: false,
			reason: "timeout",
			message: "Search timed out",
			partialResults: hits,
		};
	}

	return {
		ok: false,
		reason: "error",
		message: streamResult.stderr || "Search failed",
		partialResults: hits,
	};
}

// ── rgRegexSearch ────────────────────────────────────────────────────────────

/** Retry once with --pcre2 when look-around / backreference unsupported. */
async function regexAttempt(
	rgPath: string,
	rootDir: string,
	pattern: string,
	opts: RgOptions,
	usePcre2: boolean,
): Promise<{ outcome: RgOutcome<RgLineHit[]>; stderr: string; code: number | null }> {
	const hits: RgLineHit[] = [];
	const limit = opts.limit ?? 200;
	let count = 0;

	const args = await buildPrefixArgs(rootDir);
	if (usePcre2) args.push("--pcre2");
	args.push("-e", pattern);
	args.push("--", opts.startPath ?? ".");

	const streamResult = await spawnRgStream(
		rgPath,
		args,
		rootDir,
		true,
		{ timeoutMs: opts.timeoutMs ?? 10000, signal: opts.signal },
		(line) => {
			if (line.type !== "match") return "continue";
			const d = (line as RgJsonMatch).data;
			if (!d) return "continue";
			const safe = safeRelPath(d.path.text);
			if (!safe) return "continue";
			const submatches = d.submatches ?? [];
			hits.push({
				path: safe,
				line: d.line_number,
				col: submatches[0]?.start != null ? submatches[0].start + 1 : 1,
				text: d.lines.text.replace(/\r?\n$/, ""),
			});
			count++;
			if (count >= limit) return "cap";
			return "continue";
		},
	);

	return {
		outcome: streamResultToRegexOutcome(streamResult, hits),
		stderr: streamResult.stderr,
		code: streamResult.code,
	};
}

function streamResultToRegexOutcome(
	sr: StreamResult,
	hits: RgLineHit[],
): RgOutcome<RgLineHit[]> {
	if (sr.outcome === "timeout") {
		return { ok: false, reason: "timeout", message: "Search timed out", partialResults: hits };
	}
	if (sr.outcome === "aborted") {
		return { ok: false, reason: "error", message: "Search aborted", partialResults: hits };
	}
	if (sr.outcome === "error") {
		return {
			ok: false,
			reason: "error",
			message: sr.stderr.trim().split("\n")[0] ?? "rg error",
			partialResults: hits,
		};
	}
	// sr.outcome === "success"
	if (sr.code === 2) {
		return {
			ok: false,
			reason: "error",
			message: sr.stderr.trim().split("\n")[0] ?? "rg error",
			partialResults: hits,
		};
	}
	return { ok: true, results: hits, truncated: sr.truncated };
}

function isLookaroundOrBackrefError(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return (
		lower.includes("look-around") ||
		lower.includes("lookaround") ||
		lower.includes("backreference") ||
		lower.includes("back-reference") ||
		lower.includes("lookahead") ||
		lower.includes("lookbehind")
	);
}

function looksLikeRegexError(stderr: string): boolean {
	const lower = stderr.toLowerCase();
	return (
		lower.includes("regex") ||
		lower.includes("pattern") ||
		lower.includes("parse") ||
		lower.includes("syntax") ||
		lower.includes("unclosed") ||
		isLookaroundOrBackrefError(lower)
	);
}

/**
 * Regex search with a single pattern. Per-line hits ({path, line, col, text}).
 * Retries ONCE with --pcre2 on look-around/backreference errors.
 * Returns reason "invalid-pattern" when the regex itself is invalid.
 */
export async function rgRegexSearch(
	rootDir: string,
	pattern: string,
	opts: RgOptions = {},
): Promise<RgOutcome<RgLineHit[]>> {
	const trimmed = pattern.trim();
	if (!trimmed) {
		return { ok: true, results: [], truncated: false };
	}

	const rgPath = await resolveRgPath();
	if (!rgPath) {
		return { ok: false, reason: "unavailable", message: "ripgrep binary not found" };
	}

	const first = await regexAttempt(rgPath, rootDir, trimmed, opts, false);

	if (
		!first.outcome.ok &&
		first.outcome.reason === "error" &&
		isLookaroundOrBackrefError(first.stderr)
	) {
		const second = await regexAttempt(rgPath, rootDir, trimmed, opts, true);
		// If pcre2 also fails with a regex-like error, use invalid-pattern
		if (
			!second.outcome.ok &&
			second.outcome.reason === "error" &&
			looksLikeRegexError(second.stderr)
		) {
			return {
				ok: false,
				reason: "invalid-pattern",
				message: second.stderr.trim().split("\n")[0] ?? "Invalid regex pattern",
				partialResults: second.outcome.partialResults,
			};
		}
		return second.outcome;
	}

	// If first attempt failed with a regex-like error (not lookaround), it's
	// already an invalid pattern
	if (
		!first.outcome.ok &&
		first.outcome.reason === "error" &&
		looksLikeRegexError(first.stderr)
	) {
		return {
			ok: false,
			reason: "invalid-pattern",
			message: first.stderr.trim().split("\n")[0] ?? "Invalid regex pattern",
			partialResults: first.outcome.partialResults,
		};
	}

	return first.outcome;
}

// ── rgListFiles ──────────────────────────────────────────────────────────────

/**
 * List files using rg --files. Returns relative paths.
 * Note: --files with --json is not supported by rg, so we use plain-text mode.
 */
export async function rgListFiles(
	rootDir: string,
	opts: RgOptions = {},
): Promise<RgOutcome<string[]>> {
	const rgPath = await resolveRgPath();
	if (!rgPath) {
		return { ok: false, reason: "unavailable", message: "ripgrep binary not found" };
	}

	const paths: string[] = [];
	const limit = opts.limit ?? 2000;

	// Build args without --json for --files mode
	const args = [
		"--no-config",
		"--no-messages",
		"--no-follow",
		"--hidden",
		"--no-ignore",
		"--crlf",
	];
	const mounts = await loadMounts();
	if (mounts.rootIsHazardMount(rootDir)) {
		args.push("--no-mmap");
	}
	args.push(...(await exclusionGlobs(rootDir)));
	args.push("--files", "--", opts.startPath ?? ".");

	const streamResult = await spawnRgStream(
		rgPath,
		args,
		rootDir,
		false,
		{ timeoutMs: opts.timeoutMs ?? 10000, signal: opts.signal },
		() => "continue",
		(line) => {
			const trimmed = line.trim();
			if (!trimmed) return "continue";
			const safe = safeRelPath(trimmed);
			if (safe) {
				paths.push(safe);
				if (paths.length >= limit) return "cap";
			}
			return "continue";
		},
	);

	if (streamResult.outcome === "success") {
		return { ok: true, results: paths, truncated: streamResult.truncated };
	}
	return {
		ok: false,
		reason: streamResult.outcome === "timeout" ? "timeout" : "error",
		message: streamResult.stderr || "rg --files failed",
		partialResults: paths,
	};
}

// ── Test hooks ───────────────────────────────────────────────────────────────

export function _resetRgSearch(): void {
	_mountsModule = null;
}
