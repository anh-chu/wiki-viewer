/**
 * Watch-route scope resolution and event re-prefixing.
 *
 * resolveWatchScopes / scopePrefix / applyScopePrefix / createOverlapGate are
 * exported from the route precisely so this contract can be pinned without an
 * authenticated SSE connection. What is pinned here:
 *   - the root scope is unconditional and always first,
 *   - repeated ?dir= params are all honoured (a single get("dir") would leave
 *     the rest of the expanded tree unwatched),
 *   - absolute / "../" / denied / phantom dirs are dropped,
 *   - a symlinked dir whose REAL path leaves the workspace is rejected (a
 *     lexical check alone lets chokidar watch an outside tree because the
 *     watcher pool realpaths internally),
 *   - the 24-scope cap is applied AFTER dedupe and preserves request order,
 *   - events from a child scope reach the client WORKSPACE-relative,
 *   - only cross-scope duplicates are suppressed; a repeated event from one
 *     scope always passes.
 */
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
	resolveWatchScopes,
	scopePrefix,
	applyScopePrefix,
	createOverlapGate,
	MAX_WATCH_DIRS,
} from "../../app/api/wiki/watch/route.js";

// ── Fixture ──────────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];
let root: string;
let outside: string;

function makeTmp(prefix: string): string {
	const d = mkdtempSync(path.join(tmpdir(), prefix));
	tmpDirs.push(d);
	return d;
}

beforeEach(() => {
	root = makeTmp("watch-scope-root-");
	outside = makeTmp("watch-scope-outside-");

	mkdirSync(path.join(root, "child", "dir"), { recursive: true });
	mkdirSync(path.join(root, "other"), { recursive: true });
	mkdirSync(path.join(root, ".git"), { recursive: true });
	mkdirSync(path.join(root, ".proof"), { recursive: true });
	writeFileSync(path.join(root, "file.md"), "# not a directory");

	// outside -> a directory that is NOT inside the workspace
	symlinkSync(outside, path.join(root, "escape"));
	// inside -> a directory that IS inside the workspace
	symlinkSync(path.join(root, "child"), path.join(root, "inside-link"));
});

after(() => {
	for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function url(...dirs: string[]): string {
	const u = new URL("http://localhost/api/wiki/watch");
	for (const d of dirs) u.searchParams.append("dir", d);
	return u.toString();
}

/** Scopes as workspace-relative strings, for readable assertions. */
function rels(...dirs: string[]): string[] {
	return resolveWatchScopes(url(...dirs), root).map((abs) => scopePrefix(root, abs));
}

// ── Scope resolution ─────────────────────────────────────────────────────────

test("no dir param at all still yields the root scope", () => {
	const scopes = resolveWatchScopes("http://localhost/api/wiki/watch", root);
	assert.deepEqual(scopes, [root]);
});

test("repeated dir params are all accepted, in request order, root first", () => {
	assert.deepEqual(rels("other", "child", "child/dir"), [
		"",
		"other",
		"child",
		"child/dir",
	]);
});

test("explicit empty dir normalises to root and dedupes (no second scope)", () => {
	assert.deepEqual(rels(""), [""]);
	assert.deepEqual(rels("", ".", "./", "child"), ["", "child"]);
});

test("trailing slash is the same scope as without", () => {
	assert.deepEqual(rels("child/", "child"), ["", "child"]);
});

test("duplicate dirs collapse to one scope", () => {
	assert.deepEqual(rels("child", "child", "child/../child"), ["", "child"]);
});

test("absolute dir params are rejected", () => {
	assert.deepEqual(rels(path.join(root, "child")), [""]);
	assert.deepEqual(rels("/etc"), [""]);
	assert.deepEqual(rels(outside), [""]);
});

test("../ escapes are rejected", () => {
	assert.deepEqual(rels("..", "../", "../../etc", "child/../../etc"), [""]);
});

test("denied paths (.git, .proof) are rejected", () => {
	assert.deepEqual(rels(".git", ".proof", ".git/objects"), [""]);
});

test("non-existent dirs and non-directories are dropped", () => {
	assert.deepEqual(rels("nope", "child/nope", "file.md"), [""]);
});

test("symlink whose real path escapes the workspace is rejected", () => {
	// Lexically "escape" is inside root and statSync says directory, but the
	// watcher pool realpaths it, so accepting it would arm chokidar on
	// ${outside} while events were re-prefixed as "escape/...".
	assert.deepEqual(rels("escape"), [""]);
	assert.deepEqual(rels("escape/"), [""]);
});

test("symlink whose real path stays inside the workspace is accepted", () => {
	assert.deepEqual(rels("inside-link"), ["", "inside-link"]);
});

test("cap is applied AFTER dedupe and preserves request order", () => {
	const many: string[] = [];
	for (let i = 0; i < MAX_WATCH_DIRS + 6; i++) {
		const name = `d${String(i).padStart(2, "0")}`;
		mkdirSync(path.join(root, name));
		// Each dir requested twice: dedupe must run before the cap, otherwise
		// only half as many distinct dirs would be watched.
		many.push(name, name);
	}

	const got = rels(...many);
	assert.equal(got.length, MAX_WATCH_DIRS, "root + accepted dirs must hit the cap");
	assert.equal(got[0], "", "root is always first");
	// Request order preserved: d00..d22 after the root scope.
	for (let i = 1; i < got.length; i++) {
		assert.equal(got[i], `d${String(i - 1).padStart(2, "0")}`);
	}
});

// ── Event re-prefixing contract ──────────────────────────────────────────────

test("scopePrefix: root scope has no prefix, child scopes are workspace-relative", () => {
	assert.equal(scopePrefix(root, root), "");
	assert.equal(scopePrefix(root, path.join(root, "child")), "child");
	assert.equal(scopePrefix(root, path.join(root, "child", "dir")), "child/dir");
});

test("applyScopePrefix: child-scope event reaches the client workspace-relative", () => {
	// The pool rebases against ITS OWN watch root, so a scope at child/dir
	// reports "a.md" — the client must receive "child/dir/a.md".
	assert.equal(applyScopePrefix("child/dir", "a.md"), "child/dir/a.md");
	assert.equal(applyScopePrefix("child/dir", "sub/a.md"), "child/dir/sub/a.md");
	// An event for the scope directory itself collapses to the prefix.
	assert.equal(applyScopePrefix("child/dir", ""), "child/dir");
	// Root-scope events stay unprefixed.
	assert.equal(applyScopePrefix("", "a.md"), "a.md");
	assert.equal(applyScopePrefix("", ""), "");
});

// ── Overlap gate ─────────────────────────────────────────────────────────────

test("overlap gate suppresses the same event from a DIFFERENT scope only", () => {
	const gate = createOverlapGate(250);
	const rootScope = root;
	const childScope = path.join(root, "child");

	// Root scope reports child/a.md; the child scope reports the same physical
	// event a few ms later — one delivery.
	assert.equal(gate.allow("change", "child/a.md", rootScope, 1000), true);
	assert.equal(gate.allow("change", "child/a.md", childScope, 1010), false);
});

test("overlap gate always passes repeated events from the SAME scope", () => {
	const gate = createOverlapGate(250);
	const childScope = path.join(root, "child");

	// Two saves in quick succession from one watcher are two real events.
	assert.equal(gate.allow("change", "child/a.md", childScope, 1000), true);
	assert.equal(gate.allow("change", "child/a.md", childScope, 1005), true);
	assert.equal(gate.allow("change", "child/a.md", childScope, 1010), true);
});

test("overlap gate: different type or path is never suppressed", () => {
	const gate = createOverlapGate(250);
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	assert.equal(gate.allow("add", "x.md", a, 1000), true);
	assert.equal(gate.allow("change", "x.md", b, 1001), true);
	assert.equal(gate.allow("add", "y.md", b, 1002), true);
});

test("overlap gate: cross-scope duplicate passes once the window has elapsed", () => {
	const gate = createOverlapGate(250);
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	assert.equal(gate.allow("change", "x.md", a, 1000), true);
	assert.equal(gate.allow("change", "x.md", b, 1100), false);
	// A genuinely later event, past the window, is delivered.
	assert.equal(gate.allow("change", "x.md", b, 1400), true);
});

test("overlap gate: suppressed duplicate does not extend the window", () => {
	const gate = createOverlapGate(250);
	const a = path.join(root, "a");
	const b = path.join(root, "b");
	assert.equal(gate.allow("change", "x.md", a, 1000), true);
	// Repeated duplicates from b at 1100/1200 must not push the window past 1250.
	assert.equal(gate.allow("change", "x.md", b, 1100), false);
	assert.equal(gate.allow("change", "x.md", b, 1200), false);
	assert.equal(gate.allow("change", "x.md", b, 1251), true);
});

test("overlap gate: key map stays bounded", () => {
	const gate = createOverlapGate(250, 8);
	const scope = path.join(root, "a");
	for (let i = 0; i < 100; i++) gate.allow("add", `f${i}.md`, scope, 1000 + i);
	assert.ok(gate.size() <= 8, `gate size ${gate.size()} must stay within maxKeys`);
});
