/**
 * Backlink verification contract — prefilter breadth, exact limit, ordering.
 *
 * rg is a PREFILTER ONLY: parse verification decides. These tests drive
 * verifyCandidates directly through the exported test hooks, because the
 * properties at stake only appear when the 8-wide concurrent reads finish OUT
 * OF candidate order. A test over real files would usually see near-candidate
 * completion order and prove nothing, so the reader seam installs explicit
 * per-candidate delays and records actual completion order, which each test
 * asserts is genuinely inverted before asserting the property under test.
 */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
	_verifyCandidatesForTest as verifyCandidates,
	_setBacklinkReaderForTest,
	type Backlink,
} from "../../lib/search/backlinks.js";

// ── Reader seam ──────────────────────────────────────────────────────────────

const ROOT = "/virtual-workspace";

/** Completion order of reads, as candidate basenames. */
let completed: string[] = [];

/**
 * Install a reader that serves synthesized markdown and completes each read
 * after a caller-chosen delay, so completion order can be forced.
 */
function installReader(
	content: (name: string) => string,
	delayMs: (name: string) => number,
): void {
	_setBacklinkReaderForTest(async (absPath) => {
		const name = path.basename(absPath);
		const ms = delayMs(name);
		if (ms > 0) await new Promise((r) => setTimeout(r, ms));
		completed.push(name);
		return Buffer.from(content(name), "utf8");
	});
}

afterEach(() => {
	_setBacklinkReaderForTest(null);
	completed = [];
});

function candidates(names: string[]): Array<{ path: string }> {
	return names.map((n) => ({ path: n }));
}

function names(results: Backlink[]): string[] {
	return results.map((r) => r.path);
}

// ── Blocker 2: no pre-cap below the rg prefilter limit ──────────────────────

test("a genuine link past limit*3 prefix false positives is still found", async () => {
	// 150 rg hits for "[[foo" that are NOT [[foo]] — the old limit*3 pre-cap
	// (limit 50 => 150 candidates) stopped exactly here and reported no
	// backlinks at all, even though candidate 151 links to the target.
	const list: string[] = [];
	for (let i = 1; i <= 150; i++) list.push(`fp${i}.md`);
	list.push("real.md");

	installReader(
		(name) => (name === "real.md" ? "see [[foo]] here" : "see [[foo-bar]] here"),
		() => 0,
	);

	const results = await verifyCandidates(
		ROOT,
		candidates(list),
		"foo",
		"foo.md",
		50,
	);

	assert.deepEqual(names(results), ["real.md"]);
	assert.equal(completed.length, 151, "every candidate must be parsed, not just limit*3");
});

test("non-markdown and self-link candidates are never read", async () => {
	installReader(() => "[[foo]]", () => 0);

	const results = await verifyCandidates(
		ROOT,
		candidates(["foo.md", "notes.txt", "a.md", "b.markdown"]),
		"foo",
		"foo.md",
		50,
	);

	assert.deepEqual(names(results), ["a.md", "b.markdown"]);
	assert.deepEqual(completed.sort(), ["a.md", "b.markdown"]);
});

// ── Blocker 3: exact limit + candidate-order emission ───────────────────────

test("results are emitted in candidate order when reads complete in reverse", async () => {
	const list = ["c0.md", "c1.md", "c2.md", "c3.md", "c4.md", "c5.md"];

	// Forced inversion: candidate 0 takes 120ms, candidate 5 takes 20ms, so all
	// six reads are in flight together and complete in exactly reverse order.
	installReader(
		() => "links to [[foo]]",
		(name) => (6 - Number(name.slice(1, -3))) * 20,
	);

	const results = await verifyCandidates(ROOT, candidates(list), "foo", "foo.md", 50);

	assert.deepEqual(
		completed,
		["c5.md", "c4.md", "c3.md", "c2.md", "c1.md", "c0.md"],
		"the seam must actually invert completion order, or this test proves nothing",
	);
	assert.deepEqual(names(results), list, "emission order must be candidate (rg) order");
});

test("exactly limit results are returned under out-of-order completion", async () => {
	// 20 valid candidates, limit 3, concurrency 8. The first 8 candidates are in
	// flight simultaneously and complete in reverse index order (c7 first), so
	// several workers pass the pre-await capacity check before any of them push.
	// Without the settled flag + post-await re-check, they all push and the
	// caller receives more than 3 backlinks.
	const list: string[] = [];
	for (let i = 0; i < 20; i++) list.push(`c${i}.md`);

	installReader(
		() => "links to [[foo]]",
		(name) => {
			const idx = Number(name.slice(1, -3));
			// c7 -> 20ms, c6 -> 40ms, ... c0 -> 160ms; anything scheduled later is
			// deliberately slow so it is still in flight when the limit is reached.
			return idx < 8 ? (8 - idx) * 20 : 1000;
		},
	);

	const started = Date.now();
	const results = await verifyCandidates(ROOT, candidates(list), "foo", "foo.md", 3);
	const elapsed = Date.now() - started;

	assert.equal(results.length, 3, "must never exceed the requested limit");
	assert.deepEqual(
		completed.slice(0, 3),
		["c7.md", "c6.md", "c5.md"],
		"completion order must be inverted relative to candidate order",
	);
	// The three that completed first, emitted in ascending candidate order.
	assert.deepEqual(names(results), ["c5.md", "c6.md", "c7.md"]);
	assert.ok(
		elapsed < 900,
		`must resolve as soon as the limit is met, not wait for slow in-flight reads (took ${elapsed}ms)`,
	);

	// Late completions after the promise settled must not change anything, and
	// done() being reachable from several workers must stay harmless.
	const snapshot = names(results);
	await new Promise((r) => setTimeout(r, 1200));
	assert.deepEqual(names(results), snapshot, "settled result must not be mutated later");
});

test("zero candidates settles immediately", async () => {
	installReader(() => "[[foo]]", () => 0);
	const results = await verifyCandidates(ROOT, candidates(["only.txt"]), "foo", "foo.md", 50);
	assert.deepEqual(results, []);
});

test("abort stops scheduling and resolves with what was verified", async () => {
	const list: string[] = [];
	for (let i = 0; i < 40; i++) list.push(`c${i}.md`);

	installReader(() => "links to [[foo]]", () => 40);

	const ac = new AbortController();
	const p = verifyCandidates(ROOT, candidates(list), "foo", "foo.md", 50, ac.signal);
	setTimeout(() => ac.abort(), 60);

	const results = await p;
	assert.ok(results.length < 40, "abort must stop scheduling further reads");
	// Whatever came back is still in candidate order.
	const idx = results.map((r) => Number(r.path.slice(1, -3)));
	assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
});
