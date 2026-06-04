/**
 * FTS5 full-text search indexer tests.
 *
 * Drives the indexer directly (ensureIndexer + initial scan, plus indexFile /
 * deleteFile to simulate chokidar events) so assertions are deterministic and
 * do not depend on filesystem-watcher timing.
 */
import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, symlink } from "node:fs/promises";
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

after(async () => {
	await rm(tmpHome, { recursive: true, force: true });
	await rm(rootA, { recursive: true, force: true });
	await rm(rootB, { recursive: true, force: true });
});

import {
	ensureIndexer,
	ftsSearch,
	indexFile,
	deleteFile,
	purgeWorkspace,
	_resetIndexer,
	_waitForIdle,
} from "../../lib/search/indexer.js";
import { _resetSearchDb, getSearchDb } from "../../lib/search/search-db.js";
import { _resetWatcherPool } from "../../lib/search/watcher-pool.js";
import { sanitizeFtsQuery } from "../../lib/search/sanitize.js";
import { readFileSync } from "node:fs";

afterEach(() => {
	_resetIndexer();
	_resetWatcherPool();
	// Clear all rows so each test starts clean (cheaper than rebuilding the DB).
	try {
		const db = getSearchDb();
		db.exec("DELETE FROM docs; DELETE FROM docs_meta;");
	} catch {
		/* db may not exist yet */
	}
});

async function scan(wsId: string, root: string): Promise<void> {
	await ensureIndexer(wsId, root);
	await _waitForIdle(wsId);
}

test("indexes a markdown file and finds it", async () => {
	await writeFile(path.join(rootA, "notes.md"), "the quick brown fox");
	await scan("wsA", rootA);
	const res = ftsSearch("wsA", "fox", 10);
	assert.equal(res.matches.length, 1);
	assert.equal(res.matches[0]!.path, "notes.md");
	assert.match(res.matches[0]!.snippet, /<mark>fox<\/mark>/);
});

test("BM25 ordering: denser document ranks first", async () => {
	await writeFile(path.join(rootA, "sparse.md"), "alpha one two three four");
	await writeFile(
		path.join(rootA, "dense.md"),
		"alpha alpha alpha alpha alpha",
	);
	await scan("wsA", rootA);
	const res = ftsSearch("wsA", "alpha", 10);
	assert.equal(res.matches.length, 2);
	assert.equal(res.matches[0]!.path, "dense.md");
});

test("snippet contains <mark> highlight", async () => {
	const words = Array.from({ length: 200 }, (_, i) =>
		i === 100 ? "needle" : `word${i}`,
	).join(" ");
	await writeFile(path.join(rootA, "long.md"), words);
	await scan("wsA", rootA);
	const res = ftsSearch("wsA", "needle", 10);
	assert.equal(res.matches.length, 1);
	assert.match(res.matches[0]!.snippet, /<mark>needle<\/mark>/);
});

test("workspace isolation: a doc in A never appears in a B query", async () => {
	await writeFile(path.join(rootA, "secret.md"), "topsecretalpha");
	await writeFile(path.join(rootB, "secret.md"), "topsecretbeta");
	await scan("wsA", rootA);
	await scan("wsB", rootB);

	assert.equal(ftsSearch("wsA", "topsecretbeta", 10).matches.length, 0);
	assert.equal(ftsSearch("wsB", "topsecretalpha", 10).matches.length, 0);
	assert.equal(ftsSearch("wsA", "topsecretalpha", 10).matches.length, 1);
	assert.equal(ftsSearch("wsB", "topsecretbeta", 10).matches.length, 1);
});

test("incremental update on file change", async () => {
	const p = path.join(rootA, "x.md");
	await writeFile(p, "foofoo");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "foofoo", 10).matches.length, 1);

	await writeFile(p, "barbar");
	await indexFile("wsA", rootA, "x.md");
	assert.equal(ftsSearch("wsA", "foofoo", 10).matches.length, 0);
	assert.equal(ftsSearch("wsA", "barbar", 10).matches.length, 1);
});

test("deleted file no longer matches", async () => {
	await writeFile(path.join(rootA, "gone.md"), "deletetoken");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "deletetoken", 10).matches.length, 1);

	await deleteFile("wsA", "gone.md");
	assert.equal(ftsSearch("wsA", "deletetoken", 10).matches.length, 0);

	const db = getSearchDb();
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM docs_meta WHERE ws = ? AND path = ?")
		.get("wsA", "gone.md") as { n: number };
	assert.equal(row.n, 0);
});

test("frontmatter is searchable", async () => {
	await writeFile(
		path.join(rootA, "fm.md"),
		"---\ntitle: ImportantDoc\ntags: [alphatag, betatag]\n---\nbody text",
	);
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "ImportantDoc", 10).matches.length, 1);
	assert.equal(ftsSearch("wsA", "alphatag", 10).matches.length, 1);
});

test("non-text file: filename indexed, binary body skipped", async () => {
	// PNG magic header + random-ish bytes (contains a null byte -> binary).
	const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]);
	await writeFile(path.join(rootA, "diagram.png"), buf);
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "diagram", 10).matches.length, 1);
});

test("oversize file body skipped, filename still indexed", async () => {
	const big = "needlebig ".repeat(150_000); // > 1 MiB
	await writeFile(path.join(rootA, "huge.txt"), big);
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "needlebig", 10).matches.length, 0);
	assert.equal(ftsSearch("wsA", "huge", 10).matches.length, 1);
});

test("denied paths (.proof, .git) skipped", async () => {
	await mkdir(path.join(rootA, ".proof"), { recursive: true });
	await mkdir(path.join(rootA, ".git"), { recursive: true });
	await writeFile(path.join(rootA, ".proof", "foo.md"), "prooftoken");
	await writeFile(path.join(rootA, ".git", "HEAD"), "githeadtoken");
	await writeFile(path.join(rootA, "real.md"), "realtoken");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "prooftoken", 10).matches.length, 0);
	assert.equal(ftsSearch("wsA", "githeadtoken", 10).matches.length, 0);
	assert.equal(ftsSearch("wsA", "realtoken", 10).matches.length, 1);
});

test("symlink escaping the workspace is not indexed", async () => {
	// A secret file outside the workspace, reachable only via an in-root symlink.
	const outside = await mkdtemp(path.join(tmpdir(), "search-test-outside-"));
	await writeFile(path.join(outside, "leak.md"), "escapedsecrettoken");
	try {
		await symlink(
			path.join(outside, "leak.md"),
			path.join(rootA, "link.md"),
		);
	} catch {
		// Platform without symlink permission: skip.
		await rm(outside, { recursive: true, force: true });
		return;
	}
	await scan("wsA", rootA);
	// The symlinked-out content must never be searchable.
	assert.equal(ftsSearch("wsA", "escapedsecrettoken", 10).matches.length, 0);
	await rm(outside, { recursive: true, force: true });
});

test("purgeWorkspace removes all rows for that ws", async () => {
	await writeFile(path.join(rootA, "a.md"), "purgetoken one");
	await writeFile(path.join(rootA, "b.md"), "purgetoken two");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "purgetoken", 10).matches.length, 2);

	await purgeWorkspace("wsA");
	assert.equal(ftsSearch("wsA", "purgetoken", 10).matches.length, 0);

	const db = getSearchDb();
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM docs_meta WHERE ws = ?")
		.get("wsA") as { n: number };
	assert.equal(row.n, 0);
});

test("empty / whitespace / punctuation-only query returns empty without throwing", () => {
	assert.deepEqual(ftsSearch("wsA", "", 10), { matches: [], truncated: false });
	assert.deepEqual(ftsSearch("wsA", "   ", 10), {
		matches: [],
		truncated: false,
	});
	assert.deepEqual(ftsSearch("wsA", "***", 10), {
		matches: [],
		truncated: false,
	});
});

test("sanitizer neutralizes FTS5 operators", () => {
	assert.equal(sanitizeFtsQuery("alpha AND beta"), '"alpha" "AND" "beta"');
	assert.equal(sanitizeFtsQuery("foo NEAR bar"), '"foo" "NEAR" "bar"');
	// Quotes and semicolons are stripped to safe tokens.
	assert.equal(sanitizeFtsQuery('"; DROP docs'), '"DROP" "docs"');
	// Prefix star preserved.
	assert.equal(sanitizeFtsQuery("devel*"), '"devel"*');
});

test("operator-keyword query still searches literally and does not throw", async () => {
	await writeFile(path.join(rootA, "lit.md"), "this and that");
	await scan("wsA", rootA);
	// "and" is quoted by the sanitizer, so this matches the literal word.
	const res = ftsSearch("wsA", "and", 10);
	assert.equal(res.matches.length, 1);
});

test("porter stemmer collapses inflections", async () => {
	await writeFile(path.join(rootA, "stem.md"), "running fast");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "run", 10).matches.length, 1);
});

test("diacritic folding: café matches cafe", async () => {
	await writeFile(path.join(rootA, "dia.md"), "the cafe is open");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "café", 10).matches.length, 1);
});

test("prefix search with * finds longer words", async () => {
	await writeFile(path.join(rootA, "pre.md"), "developer notes");
	await scan("wsA", rootA);
	assert.equal(ftsSearch("wsA", "devel*", 10).matches.length, 1);
});

test("concurrent ensureIndexer is deduped (single scan)", async () => {
	await writeFile(path.join(rootA, "dedupe.md"), "dedupetoken");
	const [a, b] = [
		ensureIndexer("wsA", rootA),
		ensureIndexer("wsA", rootA),
	];
	await Promise.all([a, b]);
	await _waitForIdle("wsA");
	const db = getSearchDb();
	const row = db
		.prepare("SELECT COUNT(*) AS n FROM docs WHERE ws = ? AND path = ?")
		.get("wsA", "dedupe.md") as { n: number };
	assert.equal(row.n, 1); // not double-inserted
});

test("unchanged file (same size+mtime) is not re-indexed", async () => {
	const p = path.join(rootA, "stable.md");
	await writeFile(p, "stabletoken");
	await scan("wsA", rootA);
	const db = getSearchDb();
	const first = db
		.prepare("SELECT indexed_at FROM docs_meta WHERE ws = ? AND path = ?")
		.get("wsA", "stable.md") as { indexed_at: string };

	await new Promise((r) => setTimeout(r, 5));
	await indexFile("wsA", rootA, "stable.md"); // no file change
	const second = db
		.prepare("SELECT indexed_at FROM docs_meta WHERE ws = ? AND path = ?")
		.get("wsA", "stable.md") as { indexed_at: string };
	assert.equal(first.indexed_at, second.indexed_at);
});

test("rename via delete+add keeps only the new path", async () => {
	await writeFile(path.join(rootA, "old.md"), "renametoken");
	await scan("wsA", rootA);
	await deleteFile("wsA", "old.md");
	await writeFile(path.join(rootA, "new.md"), "renametoken");
	await indexFile("wsA", rootA, "new.md");
	const res = ftsSearch("wsA", "renametoken", 10);
	assert.equal(res.matches.length, 1);
	assert.equal(res.matches[0]!.path, "new.md");
});

test("DEFENSIVE: every 'FROM docs' in indexer.ts is ws-scoped", () => {
	const raw = readFileSync(
		new URL("../../lib/search/indexer.ts", import.meta.url),
		"utf-8",
	);
	// Strip block and line comments so prose mentioning "FROM docs" is ignored;
	// only real SQL counts.
	const src = raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/\/\/.*$/gm, "");
	// Find each SELECT/DELETE ... FROM docs and assert a ws filter follows.
	const re = /FROM docs\b([\s\S]{0,120})/g;
	let m: RegExpExecArray | null;
	let count = 0;
	while ((m = re.exec(src)) !== null) {
		count++;
		assert.match(
			m[1]!,
			/ws\s*=\s*\?/,
			`A 'FROM docs' query is missing a ws filter:\n${m[0]}`,
		);
	}
	assert.ok(count >= 1, "expected at least one 'FROM docs' query");
});
