/**
 * Demand-driven search library tests — backlinks, filename-search, slug-listing,
 * .pi exclusion, and legacy-db-cleanup.
 *
 * No database, no indexer imports, no waiting for background work.
 * Every assertion drives the new library functions directly with a rootDir.
 *
 * Fixture/teardown modelled on search-index.test.ts (two temp roots recreated
 * in afterEach for isolation). RG-dependent tests copy the availability guard
 * from rg-search.test.ts so a machine without ripgrep still passes.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// ── Fixture ──────────────────────────────────────────────────────────────────

let tmpHome: string;
let rootA: string;
let rootB: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "demand-test-home-"));
	process.env.HOME = tmpHome;
	rootA = await mkdtemp(path.join(tmpdir(), "demand-test-rootA-"));
	rootB = await mkdtemp(path.join(tmpdir(), "demand-test-rootB-"));
});

after(() => {
	rmSync(tmpHome, { recursive: true, force: true });
	rmSync(rootA, { recursive: true, force: true });
	rmSync(rootB, { recursive: true, force: true });
});

afterEach(async () => {
	rmSync(rootA, { recursive: true, force: true });
	rmSync(rootB, { recursive: true, force: true });
	rootA = await mkdtemp(path.join(tmpdir(), "demand-test-rootA-"));
	rootB = await mkdtemp(path.join(tmpdir(), "demand-test-rootB-"));
});

// ── Imports ──────────────────────────────────────────────────────────────────

import { resolveRgPath } from "../../lib/search/rg-path.js";
import { rgListFiles } from "../../lib/search/rg-search.js";
import { resolveBacklinks, type Backlink } from "../../lib/search/backlinks.js";
import { searchFilenames, FILE_LIST_LIMIT } from "../../lib/search/filename-search.js";
import { listSlugs } from "../../lib/wiki/slug-listing.js";
import { deleteLegacySearchDb } from "../../lib/search/legacy-db-cleanup.js";

// ── RG availability guard ────────────────────────────────────────────────────

let rgAvailable = false;

test("rg available", { skip: false }, async () => {
	rgAvailable = (await resolveRgPath()) !== null;
});

// ═══════════════════════════════════════════════════════════════════════════════
// Backlinks
// ═══════════════════════════════════════════════════════════════════════════════

test("backlinks: [[target]] in other.md yields exactly one entry with <mark>-wrapped snippet", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# Target");
	await writeFile(path.join(rootA, "other.md"), "See [[target]] for details.");
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 1);
	assert.equal(backlinks[0]!.path, "other.md");
	assert.match(backlinks[0]!.snippet, /<mark>/);
});

test("backlinks: ten occurrences in one file still yields one entry", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	let body = "";
	for (let i = 0; i < 10; i++) body += "[[target]] ";
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "linker.md"), body);
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 1, "ten occurrences deduped to one entry");
});

test("backlinks: self-link exclusion — target own file never returned", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "self.md"), "[[self]] reference");
	await writeFile(path.join(rootA, "other.md"), "[[self]] from other");
	const { backlinks } = await resolveBacklinks(rootA, "self.md");
	const paths = backlinks.map((b) => b.path);
	assert.ok(!paths.includes("self.md"), "self-link must be excluded");
	assert.ok(paths.includes("other.md"), "other file must appear");
});

test("backlinks: [[target|see this]] is found", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# Target");
	await writeFile(path.join(rootA, "aliaser.md"), "See [[target|see this]] for details.");
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 1);
	assert.equal(backlinks[0]!.path, "aliaser.md");
});

test("backlinks: [[target#section]] is found", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# Target");
	await writeFile(path.join(rootA, "anchored.md"), "See [[target#section]] for details.");
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 1);
	assert.equal(backlinks[0]!.path, "anchored.md");
});

test("backlinks: Target.md and Other.md both resolve (case-insensitive)", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "Target.md"), "# Target");
	await writeFile(path.join(rootA, "Other.md"), "See [[target]] for details.");
	const { backlinks } = await resolveBacklinks(rootA, "Target.md");
	assert.equal(backlinks.length, 1);
	assert.equal(backlinks[0]!.path, "Other.md");
});

test("backlinks: [[foobar]] yields ZERO backlinks for target 'foo' — prefix false positive", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "foo.md"), "# Foo");
	await writeFile(path.join(rootA, "foobar-ref.md"), "See [[foobar]] for details.");
	const { backlinks } = await resolveBacklinks(rootA, "foo.md");
	assert.equal(backlinks.length, 0, "[[foobar]] must NOT match target 'foo' — verification pass rejects prefix");
});

test("backlinks: bracket-less mention yields nothing", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "mention.md"), "the target was reached without brackets");
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 0, "mere mention without [[ ]] must not produce backlink");
});

test("backlinks: .json file containing [[target]] yields nothing", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "data.json"), '{"ref": "[[target]]"}');
	const { backlinks } = await resolveBacklinks(rootA, "target.md");
	assert.equal(backlinks.length, 0, ".json file must be skipped (non-markdown extension)");
});

test("backlinks: file in root B never appears in results for root A", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "shared.md"), "# shared");
	await writeFile(path.join(rootA, "fromA.md"), "[[shared]]");
	await writeFile(path.join(rootB, "shared.md"), "# shared");
	await writeFile(path.join(rootB, "fromB.md"), "[[shared]]");
	const aResult = await resolveBacklinks(rootA, "shared.md");
	const bResult = await resolveBacklinks(rootB, "shared.md");
	// Root A results must only contain fromA.md
	const aPaths = aResult.backlinks.map((b) => b.path);
	assert.ok(aPaths.includes("fromA.md"), "fromA.md must appear in root A results");
	assert.ok(!aPaths.includes("fromB.md"), "fromB.md must not appear in root A results");
	// Root B results must only contain fromB.md
	const bPaths = bResult.backlinks.map((b) => b.path);
	assert.ok(bPaths.includes("fromB.md"), "fromB.md must appear in root B results");
	assert.ok(!bPaths.includes("fromA.md"), "fromA.md must not appear in root B results");
});

test("backlinks: limit is respected", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "target.md"), "# Target");
	// Create 10 source files all linking to target.
	for (let i = 0; i < 10; i++) {
		await writeFile(path.join(rootA, `src${i}.md`), `[[target]]`);
	}
	const { backlinks } = await resolveBacklinks(rootA, "target.md", { limit: 3 });
	assert.equal(backlinks.length, 3, "limit=3 must return exactly 3 results");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Filename search
// ═══════════════════════════════════════════════════════════════════════════════

test("filename-search: markdown found by name", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "my-notes.md"), "# notes");
	await writeFile(path.join(rootA, "journal.md"), "# journal");
	const { paths } = await searchFilenames(rootA, "notes", 10);
	assert.ok(paths.some((p) => p === "my-notes.md"));
});

test("filename-search: binary file found by name", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Write a PNG header to simulate a binary file.
	const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
	await writeFile(path.join(rootA, "screenshot.png"), buf);
	const { paths } = await searchFilenames(rootA, "screenshot", 10);
	assert.equal(paths.length, 1);
	assert.equal(paths[0], "screenshot.png");
});

test("filename-search: multi-token AND intersection", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "alpha-beta-gamma.md"), "# abc");
	await writeFile(path.join(rootA, "alpha-delta.md"), "# ad");
	const { paths } = await searchFilenames(rootA, "alpha beta", 10);
	assert.ok(paths.includes("alpha-beta-gamma.md"), "intersection hit");
	assert.ok(!paths.includes("alpha-delta.md"), "missing token excluded");
});

test("filename-search: token matching nothing returns empty", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await writeFile(path.join(rootA, "readme.md"), "# readme");
	const { paths } = await searchFilenames(rootA, "nonexistent", 10);
	assert.equal(paths.length, 0);
});

test("filename-search: file under .proof/ never returned", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await mkdir(path.join(rootA, ".proof"), { recursive: true });
	await writeFile(path.join(rootA, ".proof", "secret.md"), "# secret");
	await writeFile(path.join(rootA, "public.md"), "# public");
	const { paths } = await searchFilenames(rootA, "secret", 10);
	assert.equal(paths.length, 0, ".proof files must not appear");
});

test("filename-search: FILE_LIST_LIMIT >= 100 * 200", () => {
	assert.ok(
		FILE_LIST_LIMIT >= 100 * 200,
		`FILE_LIST_LIMIT=${FILE_LIST_LIMIT} must be >= 20000 (100 × caller cap of 200)`,
	);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Slug listing
// ═══════════════════════════════════════════════════════════════════════════════

test("slug-listing: buckets populated from root and entities/", async () => {
	await writeFile(path.join(rootA, "root-page.md"), "# root page");
	await mkdir(path.join(rootA, "entities"), { recursive: true });
	await writeFile(path.join(rootA, "entities", "alpha.md"), "# alpha");
	const { buckets, slugMap } = await listSlugs(rootA);
	assert.equal(buckets.root.length, 1);
	assert.equal(buckets.root[0], "root-page");
	assert.equal(buckets.entities.length, 1);
	assert.equal(buckets.entities[0], "alpha");
	assert.equal(buckets.concepts.length, 0);
	assert.equal(buckets.comparisons.length, 0);
});

test("slug-listing: file at deep/nested/foo.md is ABSENT (non-recursion)", async () => {
	await mkdir(path.join(rootA, "entities", "deep", "nested"), { recursive: true });
	await writeFile(path.join(rootA, "entities", "deep", "nested", "foo.md"), "# nested");
	const { buckets } = await listSlugs(rootA);
	assert.equal(buckets.entities.length, 0, "deep/nested/foo.md must NOT appear — non-recursive scan");
});

test("slug-listing: slug map resolves 'foo' to 'entities/foo.md'", async () => {
	await mkdir(path.join(rootA, "entities"), { recursive: true });
	await writeFile(path.join(rootA, "entities", "foo.md"), "# foo");
	const { slugMap } = await listSlugs(rootA);
	assert.equal(slugMap.get("foo"), "entities/foo.md");
});

test("slug-listing: missing bucket directories do not throw", async () => {
	// No entities/, concepts/, or comparisons/ directories exist.
	const { buckets } = await listSlugs(rootA);
	assert.equal(buckets.entities.length, 0);
	assert.equal(buckets.concepts.length, 0);
	assert.equal(buckets.comparisons.length, 0);
});

test("slug-listing: duplicate slug precedence — root wins over entities", async () => {
	await writeFile(path.join(rootA, "dup.md"), "# root dup");
	await mkdir(path.join(rootA, "entities"), { recursive: true });
	await writeFile(path.join(rootA, "entities", "dup.md"), "# entities dup");
	const { slugMap } = await listSlugs(rootA);
	assert.equal(slugMap.get("dup"), "dup.md", "root precedence: dup must resolve to root file");
	assert.equal(slugMap.get("dup"), "dup.md");
});

// ═══════════════════════════════════════════════════════════════════════════════
// .pi exclusion (via ALWAYS_EXCLUDED in rg-search.ts)
// ═══════════════════════════════════════════════════════════════════════════════

test(".pi exclusion: file at <root>/.pi/hidden.md is not listed by rgListFiles", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	await mkdir(path.join(rootA, ".pi"), { recursive: true });
	await writeFile(path.join(rootA, ".pi", "hidden.md"), "# hidden");
	await writeFile(path.join(rootA, "visible.md"), "# visible");
	const result = await rgListFiles(rootA, { limit: 100 });
	assert.ok(result.ok, "rgListFiles must succeed");
	if (!result.ok) return;
	const paths = result.results as string[];
	assert.ok(paths.includes("visible.md"), "visible.md must appear");
	assert.ok(!paths.includes(".pi/hidden.md"), ".pi/hidden.md must NOT appear");
	assert.ok(!paths.some((p) => p.includes(".pi")), "no .pi path must appear");
});

test(".pi exclusion: root inside .pi/ still lists its own note.md", async (t) => {
	if (!rgAvailable) { t.skip(); return; }
	// Create a root whose path IS inside a .pi directory.
	const piAgentRoot = await mkdtemp(path.join(tmpdir(), ".pi-agent-"));
	await writeFile(path.join(piAgentRoot, "note.md"), "# note inside .pi agent");
	const result = await rgListFiles(piAgentRoot, { limit: 100 });
	// Cleanup
	rmSync(piAgentRoot, { recursive: true, force: true });

	assert.ok(result.ok, "rgListFiles must succeed inside .pi root");
	if (!result.ok) return;
	const paths = result.results as string[];
	assert.ok(paths.includes("note.md"), "note.md inside .pi-rooted workspace must be listed");
});

// ═══════════════════════════════════════════════════════════════════════════════
// Legacy DB cleanup
// ═══════════════════════════════════════════════════════════════════════════════

test("legacy-db-cleanup: creates three files, call deletes all, call again no throw", () => {
	// Use the same HOME we set in before().
	const homeDir = tmpHome;
	const dbDir = path.join(homeDir, ".wiki-viewer");
	mkdirSync(dbDir, { recursive: true });

	const dbPath = path.join(dbDir, "search.db");
	const walPath = path.join(dbDir, "search.db-wal");
	const shmPath = path.join(dbDir, "search.db-shm");

	// Create all three files.
	writeFileSync(dbPath, "fake db", "utf8");
	writeFileSync(walPath, "fake wal", "utf8");
	writeFileSync(shmPath, "fake shm", "utf8");

	// Verify they exist.
	assert.ok(existsSync(dbPath), "search.db must exist before cleanup");
	assert.ok(existsSync(walPath), "search.db-wal must exist before cleanup");
	assert.ok(existsSync(shmPath), "search.db-shm must exist before cleanup");

	// First call — deletes all.
	deleteLegacySearchDb();
	assert.ok(!existsSync(dbPath), "search.db must be gone after cleanup");
	assert.ok(!existsSync(walPath), "search.db-wal must be gone after cleanup");
	assert.ok(!existsSync(shmPath), "search.db-shm must be gone after cleanup");

	// Second call — no throw.
	deleteLegacySearchDb();
});

test("legacy-db-cleanup: directory absent, no throw", () => {
	// HOME is a temp dir with no .wiki-viewer/ subdirectory.
	deleteLegacySearchDb(); // must not throw
});

test("legacy-db-cleanup: partially missing files handled gracefully", () => {
	const homeDir = tmpHome;
	const dbDir = path.join(homeDir, ".wiki-viewer");
	mkdirSync(dbDir, { recursive: true });

	// Only create one of the three files.
	writeFileSync(path.join(dbDir, "search.db"), "fake", "utf8");

	deleteLegacySearchDb();

	assert.ok(!existsSync(path.join(dbDir, "search.db")), "search.db must be gone");
	// No throw for the missing shm/wal.
});

// ═══════════════════════════════════════════════════════════════════════════════
// DEFENSIVE source-text tests
// ═══════════════════════════════════════════════════════════════════════════════

test("DEFENSIVE: no file under src/lib/search/ contains 'readdir' (excluding indexer.ts)", () => {
	const searchDir = path.join(process.cwd(), "src", "lib", "search");

	function* walkFiles(dir: string): Generator<string> {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = path.join(dir, e.name);
			if (e.isDirectory()) {
				yield* walkFiles(full);
			} else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) {
				yield full;
			}
		}
	}

	for (const filePath of walkFiles(searchDir)) {
		const rel = path.relative(searchDir, filePath);
		// Exclude indexer.ts — it will be deleted later and still uses readdir.
		// FIXME: remove this exclusion when indexer.ts is deleted.
		if (rel === "indexer.ts") continue;

		const content = readFileSync(filePath, "utf8");
		if (content.includes("readdir")) {
			assert.fail(`${rel} contains "readdir" — tree walks must not return`);
		}
	}
});

test("DEFENSIVE: slug-listing.ts contains neither 'recursive: true' nor a self-recursive call", () => {
	const filePath = path.join(process.cwd(), "src", "lib", "wiki", "slug-listing.ts");
	const content = readFileSync(filePath, "utf8");

	// Target the dangerous pattern, not the word. The file's header comment
	// deliberately says it must never become recursive, so asserting on the
	// bare word "recursive" would trip over the very warning we mandated.
	assert.ok(
		!/recursive\s*:\s*true/.test(content),
		"slug-listing.ts must not pass { recursive: true } — bounded single-level scan only",
	);

	// The reader function must never call itself. Check for a self-reference
	// inside its own body rather than counting occurrences file-wide, so that
	// adding a bucket directory does not fail this test for the wrong reason.
	const declIdx = content.indexOf("function readMarkdownSlugsFromDir");
	assert.ok(declIdx >= 0, "readMarkdownSlugsFromDir declaration must exist");
	const afterDecl = content.slice(declIdx + "function readMarkdownSlugsFromDir".length);
	const bodyEnd = afterDecl.indexOf("\n}");
	const body = bodyEnd >= 0 ? afterDecl.slice(0, bodyEnd) : afterDecl;
	assert.ok(
		!body.includes("readMarkdownSlugsFromDir"),
		"readMarkdownSlugsFromDir must not call itself — that would be a tree walk",
	);

	// The file must stay short and auditable.
	assert.ok(content.length < 5000, "slug-listing.ts must stay under 5 KB for auditability");
});
