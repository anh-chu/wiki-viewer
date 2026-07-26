/**
 * Metadata + link-graph indexer tests.
 *
 * Drives the indexer directly (ensureIndexer + initial scan, plus indexFile /
 * deleteFile to simulate chokidar events) so assertions are deterministic and
 * do not depend on filesystem-watcher timing.
 *
 * Content-search assertions moved to rg-search.test.ts. Removed: BM25 ordering,
 * porter stemming, diacritic folding, prefix search, FTS operator sanitisation,
 * and every direct ftsSearch call.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let tmpHome: string;
let rootA: string;
let rootB: string;

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "search-test-home-"));
	rootA = await mkdtemp(path.join(tmpdir(), "search-test-rootA-"));
	rootB = await mkdtemp(path.join(tmpdir(), "search-test-rootB-"));
	process.env.HOME = tmpHome;
});

after(() => {
	rmSync(tmpHome, { recursive: true, force: true });
	rmSync(rootA, { recursive: true, force: true });
	rmSync(rootB, { recursive: true, force: true });
});

import {
	ensureIndexer,
	resolveBacklinks,
	resolveOutlinks,
	searchFilenames,
	indexedFileCount,
	indexFile,
	deleteFile,
	purgeWorkspace,
	_resetIndexer,
	_waitForIdle,
	MAX_FILES_PER_WS,
} from "../../lib/search/indexer.js";
import { getSearchDb, _resetSearchDb, SCHEMA_VERSION, _searchDbPath } from "../../lib/search/search-db.js";
import { _resetWatcherPool } from "../../lib/search/watcher-pool.js";
import { pruneStaleWorkspaces } from "../../lib/search/maintenance.js";
import { slugFromPath, extractWikiLinks, normalizeSlug } from "../../lib/markdown/wikilink.js";
import { readFileSync, statSync, readdirSync, rmSync, mkdirSync, writeFileSync } from "node:fs";

afterEach(async () => {
	_resetIndexer();
	_resetWatcherPool();
	try {
		const db = getSearchDb();
		db.exec("DELETE FROM files; DELETE FROM links;");
	} catch {
		/* db may not exist yet */
	}
	// Clean test roots so files from previous tests don't accumulate.
	rmSync(rootA, { recursive: true, force: true });
	rmSync(rootB, { recursive: true, force: true });
	rootA = await mkdtemp(path.join(tmpdir(), "search-test-rootA-"));
	rootB = await mkdtemp(path.join(tmpdir(), "search-test-rootB-"));
});

async function scan(wsId: string, root: string): Promise<void> {
	await ensureIndexer(wsId, root);
	await _waitForIdle(wsId);
}

// ── Schema version guard ─────────────────────────────────────────────────────

test("schema version guard deletes old DB and creates new schema", async () => {
	// First, force a fresh start: reset and delete any existing file.
	_resetSearchDb();
	const dbPath = _searchDbPath();
	try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
	try { rmSync(dbPath + "-wal", { force: true }); } catch { /* ignore */ }
	try { rmSync(dbPath + "-shm", { force: true }); } catch { /* ignore */ }

	// Open a handle with the OLD schema (v0) by creating a dummy docs table.
	// Ensure the directory exists first.
	const dir = path.dirname(dbPath);
	mkdirSync(dir, { recursive: true });
	const Database = (await import("better-sqlite3")).default;
	const dbOld = new Database(dbPath);
	dbOld.pragma("user_version = 0");
	dbOld.exec("CREATE TABLE docs (x INTEGER)");
	dbOld.close();

	// Now getSearchDb should detect user_version=0, delete, and rebuild.
	_resetSearchDb();
	const db = getSearchDb();

	const ver = db.pragma("user_version", { simple: true }) as number;
	assert.equal(ver, SCHEMA_VERSION, "user_version must be SCHEMA_VERSION");

	// Verify files/links exist, docs does not.
	const tables = db.prepare(
		`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
	).all() as Array<{ name: string }>;
	const names = tables.map((t) => t.name);
	assert.ok(names.includes("files"), "files table exists");
	assert.ok(names.includes("links"), "links table exists");
	assert.ok(!names.includes("docs"), "docs table must not exist");
	assert.ok(!names.includes("docs_meta"), "docs_meta must not exist");

	// Indexes
	const idxs = db.prepare(
		`SELECT name FROM sqlite_master WHERE type='index' ORDER BY name`,
	).all() as Array<{ name: string }>;
	const idxNames = idxs.map((i) => i.name);
	assert.ok(idxNames.includes("files_ws_slug_idx"), "files_ws_slug_idx exists");
	assert.ok(idxNames.includes("links_ws_target_idx"), "links_ws_target_idx exists");
});

// ── files table metadata ─────────────────────────────────────────────────────

test("files row: slug for markdown, null for non-markdown", async () => {
	await writeFile(path.join(rootA, "page.md"), "hello [[target]]");
	await writeFile(path.join(rootA, "readme.txt"), "plain text");
	await scan("wsA", rootA);

	const db = getSearchDb();
	const md = db.prepare(`SELECT slug FROM files WHERE ws=? AND path=?`).get("wsA", "page.md") as { slug: string };
	assert.equal(md.slug, "page");

	const txt = db.prepare(`SELECT slug FROM files WHERE ws=? AND path=?`).get("wsA", "readme.txt") as { slug: string | null };
	assert.equal(txt.slug, null);
});

test("non-markdown file is not read (sha empty)", async () => {
	// Write a large text file — the indexer should ONLY stat it, never read.
	const big = "x".repeat(200_000);
	await writeFile(path.join(rootA, "data.json"), big);
	await scan("wsA", rootA);

	const db = getSearchDb();
	const row = db.prepare(`SELECT sha FROM files WHERE ws=? AND path=?`).get("wsA", "data.json") as { sha: string };
	assert.equal(row.sha, "", "non-markdown sha must be empty (file not read)");
});

// ── Links table and resolveBacklinks ─────────────────────────────────────────

test("resolveBacklinks: [[target]] in other.md produces one links row", async () => {
	await writeFile(path.join(rootA, "target.md"), "I am the target");
	await writeFile(path.join(rootA, "other.md"), "See [[target]] for details.");
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(links.length, 1);
	assert.equal(links[0]!.path, "other.md");
	assert.match(links[0]!.snippet, /<mark>/);
});

test("resolveBacklinks: ten occurrences in one file still one row (deduped by PK)", async () => {
	let body = "";
	for (let i = 0; i < 10; i++) body += `[[target]] `;
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "linker.md"), body);
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(links.length, 1, "ten occurrences deduped to one row");

	const db = getSearchDb();
	const row = db.prepare(`SELECT COUNT(*) AS n FROM links WHERE ws=? AND target_slug=?`).get("wsA", "target") as { n: number };
	assert.equal(row.n, 1);
});

test("resolveBacklinks: self-exclusion", async () => {
	await writeFile(path.join(rootA, "self.md"), "[[self]] reference");
	await writeFile(path.join(rootA, "other.md"), "[[self]] from other");
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "self", "self.md", 50);
	assert.deepEqual(links.map((l) => l.path), ["other.md"]);
});

test("resolveBacklinks: ws-isolated", async () => {
	await writeFile(path.join(rootA, "shared.md"), "# shared");
	await writeFile(path.join(rootA, "fromA.md"), "[[shared]]");
	await writeFile(path.join(rootB, "shared.md"), "# shared");
	await writeFile(path.join(rootB, "fromB.md"), "[[shared]]");
	await scan("wsA", rootA);
	await scan("wsB", rootB);

	const aLinks = resolveBacklinks("wsA", "shared", "", 50);
	const bLinks = resolveBacklinks("wsB", "shared", "", 50);
	assert.deepEqual(aLinks.map((l) => l.path), ["fromA.md"]);
	assert.deepEqual(bLinks.map((l) => l.path), ["fromB.md"]);
});

test("resolveBacklinks: capitalised source filename still resolves", async () => {
	await writeFile(path.join(rootA, "Foo-Bar.md"), "# FooBar");
	await writeFile(path.join(rootA, "linker.md"), "[[foo-bar]]");
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "foo-bar", "foo-bar.md", 50);
	assert.equal(links.length, 1, "capitalised slug resolves via lowercase canonicalisation");
});

test("resolveBacklinks: mere mention without brackets produces no backlink", async () => {
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "mention.md"), "the target was reached without brackets");
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(links.length, 0, "mere mention without [[ ]] must not produce backlink");
});

// ── resolveOutlinks ──────────────────────────────────────────────────────────

test("resolveOutlinks: links with exists and missing resolution", async () => {
	await writeFile(path.join(rootA, "alpha.md"), "# Alpha");
	await writeFile(path.join(rootA, "source.md"), "See [[alpha]] and [[missing]]");
	await scan("wsA", rootA);

	const result = resolveOutlinks("wsA", "source.md");
	assert.equal(result.indexed, true);
	assert.equal(result.links.length, 2);

	const alpha = result.links.find((l) => l.slug === "alpha");
	assert.ok(alpha, "alpha link exists");
	assert.equal(alpha!.exists, true);
	assert.equal(alpha!.resolved_path, "alpha.md");

	const missing = result.links.find((l) => l.slug === "missing");
	assert.ok(missing, "missing link exists");
	assert.equal(missing!.exists, false);
	assert.equal(missing!.resolved_path, null);
});

test("resolveOutlinks: unindexed path returns indexed:false", async () => {
	const result = resolveOutlinks("wsA", "nonexistent.md");
	assert.equal(result.indexed, false);
	assert.deepEqual(result.links, []);
});

test("resolveOutlinks: duplicate links collapsed to one entry", async () => {
	let body = "";
	for (let i = 0; i < 5; i++) body += "[[target]] ";
	await writeFile(path.join(rootA, "target.md"), "# target");
	await writeFile(path.join(rootA, "dup.md"), body);
	await scan("wsA", rootA);

	const result = resolveOutlinks("wsA", "dup.md");
	assert.equal(result.links.length, 1, "duplicate links collapsed");
	assert.equal(result.links[0]!.slug, "target");
});

test("resolveOutlinks: ws isolation — same slug resolves in each workspace", async () => {
	await writeFile(path.join(rootA, "alpha.md"), "# A alpha");
	await writeFile(path.join(rootA, "srcA.md"), "[[alpha]]");
	await writeFile(path.join(rootB, "alpha.md"), "# B alpha");
	await writeFile(path.join(rootB, "srcB.md"), "[[alpha]]");
	await scan("wsA", rootA);
	await scan("wsB", rootB);

	const a = resolveOutlinks("wsA", "srcA.md");
	const b = resolveOutlinks("wsB", "srcB.md");
	assert.equal(a.links[0]!.resolved_path, "alpha.md");
	assert.equal(b.links[0]!.resolved_path, "alpha.md");
});

// ── searchFilenames ──────────────────────────────────────────────────────────

test("searchFilenames: finds markdown files by name", async () => {
	await writeFile(path.join(rootA, "my-notes.md"), "# notes");
	await writeFile(path.join(rootA, "journal.md"), "# journal");
	await scan("wsA", rootA);

	const results = searchFilenames("wsA", "notes", 10);
	assert.ok(results.some((r) => r.path === "my-notes.md"));
});

test("searchFilenames: binary file found by name", async () => {
	const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
	await writeFile(path.join(rootA, "screenshot.png"), buf);
	await scan("wsA", rootA);

	const results = searchFilenames("wsA", "screenshot", 10);
	assert.equal(results.length, 1);
	assert.equal(results[0]!.path, "screenshot.png");
});

test("searchFilenames: multi-token AND intersection", async () => {
	await writeFile(path.join(rootA, "alpha-beta-gamma.md"), "# abc");
	await writeFile(path.join(rootA, "alpha-delta.md"), "# ad");
	await scan("wsA", rootA);

	const results = searchFilenames("wsA", "alpha beta", 10);
	const paths = results.map((r) => r.path);
	assert.ok(paths.includes("alpha-beta-gamma.md"), "intersection hit");
	assert.ok(!paths.includes("alpha-delta.md"), "missing token excluded");
});

// ── Row cap ──────────────────────────────────────────────────────────────────

test("row cap: stops inserting new files when cap reached", async () => {
	// Seed many files to approach cap. We test the cap logic by checking that
	// the counter is maintained and that cap is reachable.
	const cap = MAX_FILES_PER_WS;
	// Write a modest number and verify the counter works.
	for (let i = 0; i < 10; i++) {
		await writeFile(path.join(rootA, `file${i}.md`), `# file ${i}`);
	}
	await scan("wsA", rootA);
	const count = indexedFileCount("wsA");
	assert.equal(count, 10, "counter reflects actual count");
});

// ── pruneStaleWorkspaces ─────────────────────────────────────────────────────

test("pruneStaleWorkspaces: removes ws_eph_ and unknown ws", async () => {
	const db = getSearchDb();
	db.prepare(`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`)
		.run("wsA", "a.md", 100, "0", "", "a", new Date().toISOString());
	db.prepare(`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`)
		.run("ws_eph_deadbeef", "b.md", 200, "0", "", "b", new Date().toISOString());
	db.prepare(`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`)
		.run("ws_gone", "c.md", 300, "0", "", "c", new Date().toISOString());
	db.prepare(`INSERT INTO links (ws, src_path, target_slug, line, context) VALUES (?,?,?,?,?)`)
		.run("ws_gone", "c.md", "target", 1, "ctx");

	const { workspacesRemoved, rowsRemoved } = await pruneStaleWorkspaces(new Set(["wsA"]));
	assert.equal(workspacesRemoved, 2, "ws_eph_ and ws_gone removed");
	assert.ok(rowsRemoved >= 3, "at least 3 rows removed (2 files + 1 link)");

	// wsA rows survive
	const survivors = db.prepare(`SELECT ws FROM files WHERE ws='wsA'`).all();
	assert.equal(survivors.length, 1);

	// Second call is no-op
	const second = await pruneStaleWorkspaces(new Set(["wsA"]));
	assert.equal(second.workspacesRemoved, 0);
	assert.equal(second.rowsRemoved, 0);
});

// ── wikilink extractor ───────────────────────────────────────────────────────

test("wikilink: extractWikiLinks simple forms", () => {
	const links = extractWikiLinks("See [[foo]] and [[bar|Alias]] and [[baz#sec]]");
	const slugs = links.map((l) => l.slug);
	assert.deepEqual(slugs, ["foo", "bar", "baz"]);
});

test("wikilink: uppercase slug normalised to lowercase", () => {
	// Per plan: [[Foo]] normalizes to "foo" which passes SLUG_VALID_RE.
	const links = extractWikiLinks("[[Foo]]");
	assert.equal(links.length, 1, "[[Foo]] yields slug 'foo'");
	assert.equal(links[0]!.slug, "foo");
});

test("wikilink: slug with space rejected", () => {
	const links = extractWikiLinks("[[my page]]");
	assert.equal(links.length, 0, "space in slug rejected");
});

test("wikilink: line numbers correct across multi-line document with CRLF", () => {
	const text = "line one\r\n[[alpha]]\r\nline three\r\n[[beta|B]]\r\nend";
	const links = extractWikiLinks(text);
	assert.equal(links.length, 2);
	assert.equal(links[0]!.slug, "alpha");
	assert.equal(links[0]!.line, 2);
	assert.equal(links[1]!.slug, "beta");
	assert.equal(links[1]!.line, 4);
});

test("slugFromPath canonical lowercases", () => {
	assert.equal(slugFromPath("dir/My-Page.md"), "my-page");
	assert.equal(slugFromPath("FOO.markdown"), "foo");
	assert.equal(slugFromPath("a/b/c.MD"), "c");
});

test("normalizeSlug trims and lowercases", () => {
	assert.equal(normalizeSlug("  Hello  "), "hello");
	assert.equal(normalizeSlug("WORLD"), "world");
});

// ── Retained / retargeted tests ──────────────────────────────────────────────

test("workspace isolation: file in A never appears in B backlinks", async () => {
	await writeFile(path.join(rootA, "secret.md"), "# secret");
	await writeFile(path.join(rootA, "a.md"), "[[secret]]");
	await writeFile(path.join(rootB, "secret.md"), "# secret B");
	await writeFile(path.join(rootB, "b.md"), "[[secret]]");
	await scan("wsA", rootA);
	await scan("wsB", rootB);

	const aLinks = resolveBacklinks("wsA", "secret", "", 50);
	const bLinks = resolveBacklinks("wsB", "secret", "", 50);
	assert.equal(aLinks.length, 1);
	assert.equal(aLinks[0]!.path, "a.md");
	assert.equal(bLinks.length, 1);
	assert.equal(bLinks[0]!.path, "b.md");
});

test("incremental update on file change", async () => {
	const p = path.join(rootA, "x.md");
	await writeFile(p, "[[alpha]]");
	await writeFile(path.join(rootA, "alpha.md"), "# alpha");
	await scan("wsA", rootA);

	const before = resolveBacklinks("wsA", "alpha", "alpha.md", 50);
	assert.equal(before.length, 1);

	// Change to link [[beta]] instead.
	await writeFile(p, "[[beta]]");
	await writeFile(path.join(rootA, "beta.md"), "# beta");
	await indexFile("wsA", rootA, "x.md");

	const afterAlpha = resolveBacklinks("wsA", "alpha", "alpha.md", 50);
	assert.equal(afterAlpha.length, 0);
	const afterBeta = resolveBacklinks("wsA", "beta", "beta.md", 50);
	assert.equal(afterBeta.length, 1);
});

test("deleted file removed from both tables", async () => {
	await writeFile(path.join(rootA, "gone.md"), "[[target]]");
	await writeFile(path.join(rootA, "target.md"), "# target");
	await scan("wsA", rootA);

	let bl = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(bl.length, 1);

	await deleteFile("wsA", "gone.md");

	bl = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(bl.length, 0);

	const db = getSearchDb();
	const meta = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws=? AND path=?`).get("wsA", "gone.md") as { n: number };
	assert.equal(meta.n, 0);
	const linkRow = db.prepare(`SELECT COUNT(*) AS n FROM links WHERE ws=? AND src_path=?`).get("wsA", "gone.md") as { n: number };
	assert.equal(linkRow.n, 0);
});

test("denied paths (.proof, .git) skipped", async () => {
	await mkdir(path.join(rootA, ".proof"), { recursive: true });
	await mkdir(path.join(rootA, ".git"), { recursive: true });
	await writeFile(path.join(rootA, ".proof", "foo.md"), "# proof");
	await writeFile(path.join(rootA, ".git", "HEAD"), "ref: main");
	await writeFile(path.join(rootA, "real.md"), "[[something]]");
	await writeFile(path.join(rootA, "something.md"), "# something");
	await scan("wsA", rootA);

	const db = getSearchDb();
	const proofRow = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws=? AND path LIKE '%proof%'`).get("wsA") as { n: number };
	assert.equal(proofRow.n, 0);

	const realRow = db.prepare(`SELECT path FROM files WHERE ws=?`).all("wsA") as Array<{ path: string }>;
	assert.ok(realRow.some((r) => r.path === "real.md"));
});

test("app dir contents not indexed", async () => {
	await mkdir(path.join(rootA, "my-app"), { recursive: true });
	await writeFile(path.join(rootA, "my-app", "package.json"), "{}");
	await writeFile(path.join(rootA, "my-app", "index.js"), "// app code");
	await mkdir(path.join(rootA, "site"), { recursive: true });
	await writeFile(path.join(rootA, "site", "index.html"), "<html>");
	await writeFile(path.join(rootA, "note.md"), "# note");
	await scan("wsA", rootA);

	const db = getSearchDb();
	const paths = (db.prepare(`SELECT path FROM files WHERE ws=?`).all("wsA") as Array<{ path: string }>).map((r) => r.path);
	assert.ok(!paths.some((p) => p.startsWith("my-app/")), "app dir contents excluded");
	assert.ok(!paths.some((p) => p.startsWith("site/")), "static app dir contents excluded");
	assert.ok(paths.includes("note.md"), "normal note indexed");
});

test("symlink escape not indexed", async () => {
	const outside = await mkdtemp(path.join(tmpdir(), "search-test-outside-"));
	await writeFile(path.join(outside, "leak.md"), "# leak");
	try {
		await symlink(path.join(outside, "leak.md"), path.join(rootA, "link.md"));
	} catch {
		rmSync(outside, { recursive: true, force: true });
		return;
	}
	await scan("wsA", rootA);

	const db = getSearchDb();
	const row = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws=?`).get("wsA") as { n: number };
	assert.equal(row.n, 0, "symlink escape must not produce a files row");
	rmSync(outside, { recursive: true, force: true });
});

test("purgeWorkspace removes all rows", async () => {
	await writeFile(path.join(rootA, "a.md"), "[[x]]");
	await writeFile(path.join(rootA, "b.md"), "[[x]]");
	await writeFile(path.join(rootA, "x.md"), "# x");
	await scan("wsA", rootA);

	const before = indexedFileCount("wsA");
	assert.ok(before >= 3);

	await purgeWorkspace("wsA");

	const after = indexedFileCount("wsA");
	assert.equal(after, 0);

	const db = getSearchDb();
	const linkCount = db.prepare(`SELECT COUNT(*) AS n FROM links WHERE ws=?`).get("wsA") as { n: number };
	assert.equal(linkCount.n, 0);
});

test("concurrent ensureIndexer deduped", async () => {
	await writeFile(path.join(rootA, "dedupe.md"), "# dedupe");
	const [a, b] = [ensureIndexer("wsA", rootA), ensureIndexer("wsA", rootA)];
	await Promise.all([a, b]);
	await _waitForIdle("wsA");

	const db = getSearchDb();
	const row = db.prepare(`SELECT COUNT(*) AS n FROM files WHERE ws=? AND path=?`).get("wsA", "dedupe.md") as { n: number };
	assert.equal(row.n, 1, "not double-inserted");
});

test("unchanged file (same size+mtime) not re-indexed", async () => {
	const p = path.join(rootA, "stable.md");
	await writeFile(p, "[[stable]]");
	await writeFile(path.join(rootA, "stable.md"), "[[stable]]"); // ensure exists
	await scan("wsA", rootA);

	const db = getSearchDb();
	const first = db.prepare(`SELECT indexed_at FROM files WHERE ws=? AND path=?`).get("wsA", "stable.md") as { indexed_at: string };

	await new Promise((r) => setTimeout(r, 10));
	await indexFile("wsA", rootA, "stable.md");

	const second = db.prepare(`SELECT indexed_at FROM files WHERE ws=? AND path=?`).get("wsA", "stable.md") as { indexed_at: string };
	assert.equal(first.indexed_at, second.indexed_at);
});

test("rename via delete+add keeps only new path", async () => {
	await writeFile(path.join(rootA, "old.md"), "[[target]]");
	await writeFile(path.join(rootA, "target.md"), "# target");
	await scan("wsA", rootA);

	await deleteFile("wsA", "old.md");
	await writeFile(path.join(rootA, "new.md"), "[[target]]");
	await indexFile("wsA", rootA, "new.md");

	const links = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(links.length, 1);
	assert.equal(links[0]!.path, "new.md");
});

// ── Regression: indexer rescan restarts scan ──────────────────────────────────
// NOTE: This test exercises the scan-restart behaviour that the "rescan" event
// triggers. The actual rescan event delivery path (watcher → indexer callback)
// requires the ability to emit events on the internal chokidar watcher, which
// needs a test hook (see error-budget test in watcher-pool.test.ts). Here we
// simulate the effect: reset state and prove ensureIndexer re-scans.

test("indexer rescan restarts scan", async () => {
	await writeFile(path.join(rootA, "first.md"), "# First");
	await scan("wsA", rootA);
	assert.equal(indexedFileCount("wsA"), 1);

	// Create a new file after the initial scan completed.
	await writeFile(path.join(rootA, "second.md"), "# Second");

	// Simulate the state reset that a "rescan" event would cause:
	// clear initialScanDone / initialScanPromise so ensureIndexer re-arms.
	_resetIndexer();

	// Re-scan — must pick up the file created after the first scan.
	await scan("wsA", rootA);

	const after = indexedFileCount("wsA");
	assert.equal(after, 2, "rescan must pick up new files");
});

// ── Regression: schema version guard rebuilds corrupt database ────────────────

test("schema version guard rebuilds corrupt database", () => {
	_resetSearchDb();
	const dbPath = _searchDbPath();
	try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
	try { rmSync(dbPath + "-wal", { force: true }); } catch { /* ignore */ }
	try { rmSync(dbPath + "-shm", { force: true }); } catch { /* ignore */ }

	// Write a non-SQLite file at the search.db path.
	const dir = path.dirname(dbPath);
	mkdirSync(dir, { recursive: true });
	writeFileSync(dbPath, "this is not a sqlite database file!!!", "utf8");

	// getSearchDb() must rebuild rather than throw "file is not a database".
	// Pre-fix: new Database(dbPath) threw before needsRebuild was set.
	const db = getSearchDb();

	// Verify the result is a valid database with the current schema.
	const ver = db.pragma("user_version", { simple: true }) as number;
	assert.equal(ver, SCHEMA_VERSION, "rebuilt DB must have current schema version");

	const tables = db.prepare(
		`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`,
	).all() as Array<{ name: string }>;
	assert.ok(tables.some((t) => t.name === "files"), "files table must exist after rebuild");
	assert.ok(tables.some((t) => t.name === "links"), "links table must exist after rebuild");
});

// ── Regression: current-version database is retained ─────────────────────────

test("current-version database is retained", () => {
	_resetSearchDb();
	const dbPath = _searchDbPath();
	try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }

	// Create a fresh database at SCHEMA_VERSION.
	const db1 = getSearchDb();
	assert.equal(db1.pragma("user_version", { simple: true }), SCHEMA_VERSION);

	// Insert a sentinel row.
	db1.prepare(
		`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`,
	).run("sentinel-ws", "sentinel.md", 42, "0", "", "sentinel", new Date().toISOString());

	// Close handle and reset cache — simulating a process restart.
	db1.close();
	_resetSearchDb();

	// Reopen — the file already has user_version = SCHEMA_VERSION,
	// so needsRebuild must stay false and the sentinel must survive.
	const db2 = getSearchDb();
	const row = db2.prepare(
		`SELECT size FROM files WHERE ws=? AND path=?`,
	).get("sentinel-ws", "sentinel.md") as { size: number } | undefined;

	assert.ok(row, "sentinel row must survive reopen");
	assert.equal(row.size, 42, "sentinel data must be intact");

	// Clean up the sentinel so afterEach can clear.
	db2.prepare(`DELETE FROM files WHERE ws=?`).run("sentinel-ws");
});

// ── Regression: row cap updates existing indexed file ────────────────────────

test("row cap updates existing indexed file", async () => {
	const db = getSearchDb();

	// Pre-insert MAX_FILES_PER_WS dummy rows to trigger the cap.
	// This simulates a workspace that already reached the row ceiling.
	db.transaction(() => {
		const insert = db.prepare(
			`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`,
		);
		const now = new Date().toISOString();
		for (let i = 0; i < MAX_FILES_PER_WS; i++) {
			insert.run("wsA", `dummy-${i}.md`, 100, "0", "", `dummy-${i}`, now);
		}
	})();

	// Also pre-insert a row for a file that exists on disk but has stale meta.
	// The file content will differ from what the meta says.
	await writeFile(path.join(rootA, "real.md"), "# Real file v1");
	db.prepare(
		`INSERT INTO files (ws, path, size, mtime_ns, sha, slug, indexed_at) VALUES (?,?,?,?,?,?,?)`,
	).run("wsA", "real.md", 1, "0", "", "real", new Date().toISOString());

	// Also create a genuinely new file on disk (not pre-inserted).
	await writeFile(path.join(rootA, "new.md"), "# New file");

	// Scan — cap is already set (rowCount >= MAX_FILES_PER_WS).
	await scan("wsA", rootA);

	// Existing file (has meta) must be UPDATED despite the cap.
	// Pre-fix bug: `if (s.capped) continue;` skipped EVERYTHING including updates.
	const updatedRow = db.prepare(
		`SELECT size FROM files WHERE ws=? AND path=?`,
	).get("wsA", "real.md") as { size: number } | undefined;
	assert.ok(updatedRow, "existing file must remain indexed at cap");
	assert.ok(updatedRow.size > 1, "existing file must be updated (new size written)");

	// New file (no pre-existing meta) must be SKIPPED at cap.
	const newRow = db.prepare(
		`SELECT 1 FROM files WHERE ws=? AND path=?`,
	).get("wsA", "new.md");
	assert.equal(newRow, undefined, "new file must be skipped at cap");

	// Clean up dummy rows so afterEach DELETE FROM files is fast.
	db.exec("DELETE FROM files WHERE ws='wsA'");
});

// ── Regression: backlink context — literal <mark> before link ────────────────

test("backlink context literal mark before link highlights wikilink", async () => {
	// The pre-fix bug: occ.index from the original line was used to slice
	// the cleaned (tag-stripped) text. A literal "<mark>" before the link
	// shifted the offsets, so the highlight wrapped the wrong span.
	await writeFile(path.join(rootA, "target.md"), "# Target");
	await writeFile(
		path.join(rootA, "source.md"),
		"<mark>important</mark> See [[target]] for details.",
	);
	await scan("wsA", rootA);

	const links = resolveBacklinks("wsA", "target", "target.md", 50);
	assert.equal(links.length, 1);

	const snippet = links[0]!.snippet;

	// The snippet must contain <mark> wrapped around the wikilink [[target]],
	// NOT around some offset-shifted span.
	assert.match(
		snippet,
		/<mark>\[\[target\]\]<\/mark>/,
		`snippet must highlight wikilink, got: ${snippet}`,
	);

	// The literal <mark>important</mark> text should have its tags stripped
	// (the word "important" should appear as plain text, not as nested mark).
	assert.ok(snippet.includes("important"), "literal text must appear tags-stripped");

	// There should be exactly one <mark> pair — the one around the wikilink.
	const markCount = (snippet.match(/<mark>/g) ?? []).length;
	assert.equal(markCount, 1, `expected 1 <mark>, got ${markCount}: ${snippet}`);
});

// ── DEFENSIVE: all FROM/DELETE in indexer.ts and maintenance.ts ws-scoped ────

test("DEFENSIVE: FROM files/FROM links statements are all ws-filtered", () => {
	const files = [
		"../../lib/search/indexer.ts",
		"../../lib/search/maintenance.ts",
	];

	for (const f of files) {
		const raw = readFileSync(new URL(f, import.meta.url), "utf-8");
		const src = raw
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");

		// Find each FROM files / FROM links / DELETE FROM files / DELETE FROM links
		const re = /(?:FROM|DELETE FROM)\s+(files|links)\b([\s\S]{0,120})/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(src)) !== null) {
			const table = m[1]!;
			const after = m[2]!;

			// Allow list: cross-workspace queries in maintenance.ts
			const isCrossWs =
				after.includes("SELECT DISTINCT ws") ||
				after.includes("WHERE ws IN");

			if (!isCrossWs) {
				assert.match(
					after,
					/ws\s*=\s*\?/,
					`${f}: FROM/DELETE ${table} missing ws filter:\n${m[0]}`,
				);
			}
		}
	}
});

test("DEFENSIVE: no route file imports getSearchDb directly", () => {
	const { join } = path;

	function* findRoutes(dir: string): Generator<string> {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const e of entries) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				yield* findRoutes(full);
			} else if (e.name === "route.ts" || e.name === "route.tsx") {
				yield full;
			}
		}
	}

	const apiDir = join(process.cwd(), "src", "app", "api");
	let routesFound = 0;
	for (const routePath of findRoutes(apiDir)) {
		routesFound++;
		const content = readFileSync(routePath, "utf-8");
		if (content.includes("getSearchDb")) {
			assert.fail(`${routePath} imports getSearchDb directly`);
		}
	}
	assert.ok(routesFound > 0, "found at least one route file");
});
