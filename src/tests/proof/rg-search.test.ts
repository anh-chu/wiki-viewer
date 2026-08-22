/**
 * Ripgrep content-search engine tests.
 *
 * Runs over a tmpdir fixture tree. Skips the whole suite when resolveRgPath()
 * returns null, so a machine without ripgrep still passes.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, symlink, mkdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveRgPath, _resetRgPath } from "../../lib/search/rg-path.js";
import {
	buildSnippet,
	stripMarkTags,
	SNIPPET_WINDOW,
} from "../../lib/search/rg-snippet.js";
import {
	rgLiteralSearch,
	rgRegexSearch,
	rgListFiles,
	type RgFileHit,
} from "../../lib/search/rg-search.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

let rootDir: string;

before(async () => {
	rootDir = await mkdtemp(path.join(tmpdir(), "rg-test-"));
});

after(async () => {
	await rm(rootDir, { recursive: true, force: true });
});

async function seed(files: Record<string, string>) {
	for (const [relPath, content] of Object.entries(files)) {
		const abs = path.join(rootDir, relPath);
		await mkdir(path.dirname(abs), { recursive: true });
		await writeFile(abs, content, "utf8");
	}
}

// ── Suite guard ──────────────────────────────────────────────────────────────

let rgAvailable = false;

test("rg available", { skip: false }, async () => {
	rgAvailable = (await resolveRgPath()) !== null;
});

// ── rg-snippet.ts unit tests ─────────────────────────────────────────────────

test("stripMarkTags removes literal mark tags", () => {
	assert.equal(stripMarkTags("hello <mark>world</mark>"), "hello world");
	assert.equal(
		stripMarkTags("before <mark>inner</mark> after"),
		"before inner after",
	);
	assert.equal(stripMarkTags("no tags"), "no tags");
	// "<<mark>>" contains "<mark>" as a substring — it gets stripped
	assert.equal(stripMarkTags("<<mark>>"), "<>");
});

test("buildSnippet ASCII highlight position", () => {
	const line = "the quick brown fox jumps over the lazy dog";
	const submatches = [{ start: 4, end: 9 }]; // "quick"
	const result = buildSnippet(line, submatches);
	// "quick" should be wrapped in <mark>
	assert.ok(result.includes("<mark>quick</mark>"));
});

test("buildSnippet handles leading emoji (byte vs char regression guard)", () => {
	// "🎉" is 4 bytes in UTF-8
	const emoji = "🎉";
	const line = emoji + "hello world";
	// "hello" starts at byte 4
	const submatches = [{ start: 4, end: 9 }];
	const result = buildSnippet(line, submatches);
	// Must highlight "hello", not some garbled slice
	assert.ok(result.includes("<mark>hello</mark>"), `got: ${result}`);
});

test("buildSnippet handles accented characters (byte vs char regression guard)", () => {
	// "é" is 2 bytes in UTF-8, "à" is 2 bytes
	// "café résumé voilà" = 21 bytes
	// c(0) a(1) f(2) é(3-4) space(5) r(6) é(7-8) s(9) u(10) m(11) é(12-13)
	// "résumé" starts at byte 6, 8 bytes long, ends at byte 14 (exclusive)
	const line = "café résumé voilà";
	const submatches = [{ start: 6, end: 14 }];
	const result = buildSnippet(line, submatches);
	assert.ok(result.includes("<mark>résumé</mark>"), `got: ${result}`);
});

test("buildSnippet literal mark in content produces no spurious highlight", () => {
	const line = "some <mark>evil</mark> text here hello world";
	// "hello" at byte position — let's just search for "text"
	// text starts at byte 26
	const submatchesText = [{ start: 26, end: 30 }]; // "text"
	const result = buildSnippet(line, submatchesText);
	// The literal <mark>evil</mark> should be stripped of its tags
	assert.ok(result.includes("evil"), `got: ${result}`);
	// Count <mark> occurrences — should be exactly 1 (our injected one around "text")
	const markCount = (result.match(/<mark>/g) ?? []).length;
	assert.equal(markCount, 1, `expected 1 <mark>, got ${markCount}: ${result}`);
});

test("buildSnippet out-of-window elision with ellipsis", () => {
	// Build a line longer than 2*window
	const prefix = "a".repeat(100);
	const match = "TARGET";
	const suffix = "b".repeat(100);
	const line = prefix + match + suffix;
	// Match is at byte 100-106
	const submatches = [{ start: 100, end: 106 }];
	const result = buildSnippet(line, submatches, { window: 20 });
	// Should start with ellipsis (truncated start)
	assert.ok(result.startsWith("…"), `expected … prefix, got: ${result.slice(0, 10)}`);
	// Should end with ellipsis (truncated end)
	assert.ok(result.endsWith("…"), `expected … suffix, got: ${result.slice(-10)}`);
	// Should contain the highlighted target
	assert.ok(result.includes("<mark>TARGET</mark>"), `got: ${result}`);
});

// ── Regression: buildSnippet mixed-width boundary has no replacement char ────

test("buildSnippet mixed-width boundary has no replacement character", () => {
	// Construct a line where the ±window boundary falls inside a multi-byte
	// UTF-8 sequence. Without code-point rounding, slicing mid-character
	// would produce U+FFFD (replacement character).

	// Test winEnd rounding: match near start, window end inside a 4-byte emoji.
	// "🎉" = F0 9F 8E 89 (4 bytes). Put it so winEnd falls on byte 2 of the emoji.
	// Layout: "HELLO"(5) + "x"*55(55) + "🎉"(4) + "y"*40(40) = 104 bytes
	// Match "HELLO" at [0,5), centre=2. winEnd = 2+60 = 62.
	// Byte 62 = 0x8E (continuation of 🎉). Rounding retreats to byte 60 (code-point start).
	const line1 = "HELLO" + "x".repeat(55) + "🎉" + "y".repeat(40);
	const result1 = buildSnippet(line1, [{ start: 0, end: 5 }], { window: 60 });

	assert.ok(!result1.includes("\uFFFD"), `winEnd rounding must not produce U+FFFD, got: ${result1}`);
	assert.ok(result1.includes("<mark>HELLO</mark>"), "must highlight HELLO");

	// Test winStart rounding: emoji at start, match further in.
	// "🎉"(4) + "x"*56(56) + "TARGET"(6) + "y"*40(40) = 106 bytes
	// Match "TARGET" at [60,66), centre=63. winStart = max(0, 63-60) = 3.
	// Byte 3 = 0x89 (continuation of 🎉). Rounding advances to byte 4 (code-point start).
	const line2 = "🎉" + "x".repeat(56) + "TARGET" + "y".repeat(40);
	const result2 = buildSnippet(line2, [{ start: 60, end: 66 }], { window: 60 });

	assert.ok(!result2.includes("\uFFFD"), `winStart rounding must not produce U+FFFD, got: ${result2}`);
	assert.ok(result2.includes("<mark>TARGET</mark>"), "must highlight TARGET");

	// Test winStart rounding with accented chars (2-byte sequences).
	// "café" = 5 bytes (é at bytes 3-4).
	// "é"*30(60) + "MATCH"(5) + "z"*60(60) = 125 bytes
	// Match "MATCH" at [60,65), centre=62. winStart = max(0, 62-60) = 2.
	// Byte 2 = 'f' (ASCII) — no rounding needed. But winEnd = 62+60 = 122 which is ASCII.
	// Let us instead put a multi-byte char at the right place.
	// "café" has é at bytes 3-4. If match is at [4,9) with centre 6:
	// winStart = max(0, 6-60) = 0. winEnd = min(66, 6+60) = 66.
	// Still no boundary issue.

	// More targeted: put "é" at byte 60 so winEnd=62 hits continuation byte.
	// "x"*60(60) + "é"(2) + "MATCH"(5) + "z"*40(40) = 107 bytes
	// Match "MATCH" at [62,67), centre=64.
	// winStart = max(0, 64-60) = 4. winEnd = min(107, 64+60) = 107 (end of string).
	// winStart=4 is in ASCII. Still OK.

	// Put "é" so winStart hits its continuation byte:
	// "é"(2) + "x"*58(58) + "MATCH"(5) + "z"*40(40) = 105 bytes
	// Match "MATCH" at [60,65), centre=62.
	// winStart = max(0, 62-60) = 2. Byte 2 of "é" is... wait, "é" is bytes 0-1,
	// "x" starts at byte 2. So byte 2 is 'x' (ASCII). Still OK.
	// Need: winStart=1, where byte 1 is continuation of "é".
	// centre=61: winStart=1. Match at [59,64), centre=61.
	// "é"(2) + "x"*57(57) + "MATCH"(5) + "z"*40(40) = 104 bytes
	// Match at bytes 59-64, centre=61. winStart=1.
	// Byte 1 = 0xA9 (continuation of é). Rounding advances to byte 2.
	const line3 = "é" + "x".repeat(57) + "MATCH" + "z".repeat(40);
	const result3 = buildSnippet(line3, [{ start: 59, end: 64 }], { window: 60 });

	assert.ok(!result3.includes("\uFFFD"), `accented winStart rounding must not produce U+FFFD, got: ${result3}`);
	assert.ok(result3.includes("<mark>MATCH</mark>"), `must highlight MATCH, got: ${result3}`);
});

// ── rg-search.ts tests (skip if rg unavailable) ─────────────────────────────

test("single-token literal match", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"a.txt": "hello world\nfoo bar\n",
		"b.txt": "goodbye world\n",
	});
	const result = await rgLiteralSearch(rootDir, "hello", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.path, "a.txt");
	assert.equal(hits[0]!.firstMatch.line, 1);
	assert.ok(hits[0]!.firstMatch.snippet.includes("<mark>hello</mark>"));
});

test("multi-token AND semantics", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"both.txt": "apple banana cherry\napple banana date\n",
		"one-only.txt": "apple cherry date\n",
		"neither.txt": "x y z\n",
		"more-hits.txt": "apple banana\napple banana\napple banana\n",
	});
	const result = await rgLiteralSearch(rootDir, "apple banana", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	const paths = hits.map((h) => h.path);

	// both.txt has both tokens — included
	assert.ok(paths.includes("both.txt"));
	// more-hits.txt has both tokens with more occurrences — should rank higher
	assert.ok(paths.includes("more-hits.txt"));
	// one-only.txt is missing "banana" — excluded
	assert.ok(!paths.includes("one-only.txt"));
	// neither.txt has neither — excluded
	assert.ok(!paths.includes("neither.txt"));

	// more-hits.txt should rank above both.txt (more total matches)
	const moreIdx = paths.indexOf("more-hits.txt");
	const bothIdx = paths.indexOf("both.txt");
	assert.ok(moreIdx < bothIdx, `more-hits should rank before both, got ${paths}`);
});

test("trailing * stripped (prefix becomes substring)", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "dev.txt": "development deploy dev" });
	const result = await rgLiteralSearch(rootDir, "devel*", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	assert.equal(hits.length, 1);
	assert.equal(hits[0]!.path, "dev.txt");
});

test("regex-special chars in literal query match literally", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"special.txt": "a.b [x] foo( bar",
	});
	// All three should match literally with --fixed-strings
	for (const query of ["a.b", "[x]", "foo("]) {
		const result = await rgLiteralSearch(rootDir, query, { limit: 10 });
		assert.ok(result.ok, `query "${query}" should succeed`);
		if (!result.ok) continue;
		const hits = result.results as RgFileHit[];
		assert.equal(hits.length, 1, `query "${query}" should find 1 file`);
		assert.equal(hits[0]!.path, "special.txt");
	}
});

test("symlink outside root produces no match", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Create a file outside the root
	const outsideDir = await mkdtemp(path.join(tmpdir(), "rg-outside-"));
	const outsideFile = path.join(outsideDir, "secret.txt");
	await writeFile(outsideFile, "TOP SECRET hello\n", "utf8");
	try {
		// Create a symlink inside root pointing outside
		await seed({ "normal.txt": "hello from inside" });
		await symlink(outsideFile, path.join(rootDir, "link-to-outside.txt"));

		const result = await rgLiteralSearch(rootDir, "hello", { limit: 10 });
		assert.ok(result.ok);
		if (!result.ok) throw new Error("expected ok");
		const hits = result.results as RgFileHit[];
		// Only the normal file should be found; symlink not followed
		const paths = hits.map((h) => h.path);
		assert.ok(paths.includes("normal.txt"));
		assert.ok(!paths.includes("link-to-outside.txt"), "symlink should not be followed");
	} finally {
		await rm(outsideDir, { recursive: true, force: true });
	}
});

test(".git and .proof contents never appear", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"normal.txt": "hello",
		".git/config": "hello git",
		".proof/meta.json": "hello proof",
	});
	const result = await rgLiteralSearch(rootDir, "hello", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	const paths = hits.map((h) => h.path);
	assert.ok(paths.includes("normal.txt"));
	assert.ok(!paths.find((p) => p.includes(".git")), ".git should be excluded");
	assert.ok(!paths.find((p) => p.includes(".proof")), ".proof should be excluded");
});

test("excalidraw scene files are excluded from full-text search", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"canvas.excalidraw": "canvas-only-search-needle",
		"nested/diagram.excalidraw": "canvas-only-search-needle",
		"canvas-note.txt": "canvas-only-search-needle",
	});
	const result = await rgLiteralSearch(rootDir, "canvas-only-search-needle", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const paths = (result.results as RgFileHit[]).map((hit) => hit.path);
	assert.deepEqual(paths, ["canvas-note.txt"]);
});

test("file with null byte is skipped", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "good.txt": "hello world" });
	// Write a file with a null byte
	await writeFile(path.join(rootDir, "binary.bin"), Buffer.from([0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x62, 0x79, 0x74, 0x65]));
	const result = await rgLiteralSearch(rootDir, "hello", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	// binary.bin should be skipped by rg (null byte = binary)
	const paths = hits.map((h) => h.path);
	assert.ok(paths.includes("good.txt"));
	assert.ok(!paths.includes("binary.bin"), "binary file should be skipped");
});

test("file over max-filesize is skipped", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "small.txt": "hello" });
	// Create a file larger than 2M
	const bigPath = path.join(rootDir, "big.txt");
	const big = Buffer.alloc(3 * 1024 * 1024, "x"); // 3MB
	// Put "hello" at the start
	big.write("hello world", 0);
	await writeFile(bigPath, big);

	const result = await rgLiteralSearch(rootDir, "hello", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	const paths = hits.map((h) => h.path);
	assert.ok(paths.includes("small.txt"));
	assert.ok(!paths.includes("big.txt"), `big file should be skipped, got: ${paths}`);
});

test("empty query returns empty with no spawn", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Empty query should short-circuit
	const result = await rgLiteralSearch(rootDir, "", { limit: 10 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	assert.equal((result.results as RgFileHit[]).length, 0);
	assert.equal(result.truncated, false);

	// Whitespace-only
	const result2 = await rgLiteralSearch(rootDir, "   ", { limit: 10 });
	assert.ok(result2.ok);
	if (!result2.ok) throw new Error("expected ok");
	assert.equal((result2.results as RgFileHit[]).length, 0);
});

test("cap returns exactly limit results with truncated:true", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Create many files with matches
	const files: Record<string, string> = {};
	for (let i = 0; i < 50; i++) {
		files[`file-${i}.txt`] = "hello world";
	}
	await seed(files);

	const result = await rgLiteralSearch(rootDir, "hello", { limit: 5 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as RgFileHit[];
	assert.equal(hits.length, 5, `expected 5 results, got ${hits.length}`);
	assert.equal(result.truncated, true);
});

test("already-aborted signal resolves promptly", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "a.txt": "hello world" });
	const controller = new AbortController();
	controller.abort();

	const result = await rgLiteralSearch(rootDir, "hello", {
		signal: controller.signal,
		limit: 10,
	});
	// Should return promptly (not hang), may be error or empty
	assert.ok(!result.ok || result.results.length === 0 || result.truncated);
});

// ── Regression: pre-aborted signal performs no child work ────────────────────

test("pre-aborted signal performs no child work", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Create a fixture whose content WOULD definitely match if rg ran.
	await seed({ "match.txt": "needle-in-haystack" });

	const controller = new AbortController();
	controller.abort(); // abort BEFORE calling

	const result = await rgLiteralSearch(rootDir, "needle-in-haystack", {
		signal: controller.signal,
		limit: 10,
	});

	// If rg had actually spawned, it would have found the match.
	// Zero results proves no child work was performed.
	// The existing "resolves promptly" test passes for the wrong reason
	// because a normal truncated result also satisfies it — here we assert
	// something that can only hold if no child ran at all.
	if (result.ok) {
		assert.equal(result.results.length, 0, "pre-aborted must return zero results");
	} else {
		const hits = result.partialResults ?? [];
		assert.equal(hits.length, 0, `pre-aborted must return zero results, got ${hits.length}`);
	}
});

test("rgRegexSearch with (?=x) succeeds via pcre2 retry", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "test.txt": "xray xray extra" });
	const result = await rgRegexSearch(rootDir, "(?=x)", { limit: 10 });
	assert.ok(result.ok, `expected ok, got: ${JSON.stringify(result)}`);
	if (!result.ok) throw new Error("expected ok");
	const hits = result.results as import("../../lib/search/rg-search.js").RgLineHit[];
	assert.ok(hits.length > 0, "should find matches with lookahead");
});

test("rgRegexSearch with unclosed [ returns invalid-pattern", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({ "test.txt": "hello" });
	const result = await rgRegexSearch(rootDir, "[", { limit: 10 });
	assert.equal(result.ok, false);
	if (result.ok) throw new Error("expected failure");
	assert.equal(result.reason, "invalid-pattern");
});

// ── rgListFiles ──────────────────────────────────────────────────────────────

test("rgListFiles returns relative paths", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"foo.txt": "a",
		"bar.md": "b",
		"sub/baz.ts": "c",
		".git/ignore": "d",
	});
	const result = await rgListFiles(rootDir, { limit: 100 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const paths = result.results as string[];
	assert.ok(paths.includes("foo.txt"));
	assert.ok(paths.includes("bar.md"));
	assert.ok(paths.includes("sub/baz.ts"));
	// .git should be excluded
	assert.ok(!paths.find((p) => p.includes(".git")));
});

test("rgListFiles still lists .excalidraw (filename search keeps canvas files)", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await seed({
		"diagram.excalidraw": "{\"elements\":[]}",
		"nested/board.excalidraw": "{\"elements\":[]}",
	});
	const result = await rgListFiles(rootDir, { limit: 100 });
	assert.ok(result.ok);
	if (!result.ok) throw new Error("expected ok");
	const paths = result.results as string[];
	assert.ok(paths.includes("diagram.excalidraw"));
	assert.ok(paths.includes("nested/board.excalidraw"));
});

// ── package.json check ───────────────────────────────────────────────────────

test("package.json lists @vscode/ripgrep under optionalDependencies not dependencies", () => {
	const pkgPath = path.join(
		path.dirname(new URL(import.meta.url).pathname),
		"..",
		"..",
		"..",
		"package.json",
	);
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	assert.ok(
		pkg.optionalDependencies?.["@vscode/ripgrep"],
		"@vscode/ripgrep must be in optionalDependencies",
	);
	assert.ok(
		!pkg.dependencies?.["@vscode/ripgrep"],
		"@vscode/ripgrep must NOT be in dependencies (must be optional)",
	);
});

// ── Bundled binary resolution (regression guard for @vscode/ripgrep 1.18.0 layout) ─

test("bundled tier resolves without PATH — no WIKI_VIEWER_RG, PATH emptied", { skip: false }, async () => {
	const savedRG = process.env.WIKI_VIEWER_RG;
	const savedPATH = process.env.PATH;
	delete process.env.WIKI_VIEWER_RG;
	process.env.PATH = "";
	_resetRgPath();

	try {
		const resolved = await resolveRgPath();
		// If the platform package is not installed (non-matching platform),
		// this returns null — that is OK (optional dep).
		if (resolved === null) {
			console.warn("SKIP: bundled ripgrep not found on this platform (optional dep missing?)");
			return;
		}
		// Must be an absolute path
		assert.ok(path.isAbsolute(resolved), `expected absolute path, got: ${resolved}`);
		// Must NOT be "rg" — that would mean it fell through to the PATH tier
		// (which is empty, so it would actually be null anyway). This assertion
		// pins the property that the bundled tier resolves, not the PATH tier.
		assert.notEqual(resolved, "rg", "must not return bare 'rg' (PATH tier), bundled tier must resolve");
		// Must exist and be executable
		const { statSync } = await import("node:fs");
		const st = statSync(resolved);
		assert.ok(st.isFile(), `${resolved} is not a file`);
		assert.ok((st.mode & 0o111) !== 0, `${resolved} is not executable`);
	} finally {
		if (savedRG !== undefined) process.env.WIKI_VIEWER_RG = savedRG;
		else delete process.env.WIKI_VIEWER_RG;
		if (savedPATH !== undefined) process.env.PATH = savedPATH;
		else delete process.env.PATH;
		_resetRgPath();
	}
});
