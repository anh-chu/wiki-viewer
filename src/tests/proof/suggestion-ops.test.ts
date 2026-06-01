import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "../../lib/proof/ops-applier.js";
import { setRootDir } from "../../lib/root-dir.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-suggestion-ops-test-"));
	setRootDir(tmpRoot);
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

// ── suggestion.add (pending) ─────────────────────────────────────────────────

test("suggestion.add with status=pending → sidecar has pending suggestion + event suggestion.added", async () => {
	await writeDoc("sug-add-pending.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "sug-add-pending.md");
	assert.ok(snap !== null);
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-add-pending.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Proposed replacement.",
			basis: "described",
			basisDetail: "user mentioned slippage",
		}],
	});

	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);
	const sug = result.ok ? result.snapshot.suggestions[0] : null;
	assert.ok(sug, "pending suggestion should be present in snapshot");
	assert.equal(sug!.status, "pending");
	assert.equal(sug!.kind, "replace");
	assert.equal(sug!.markdown, "Proposed replacement.");
	assert.equal(sug!.by, "ai:claude");
	assert.equal(sug!.basisDetail, "user mentioned slippage");

	// Event: suggestion.added emitted
	assert.ok(result.ok);
	const addedEvt = result.ok
		? result.emittedEvents.find((e) => e.type === "suggestion.added")
		: null;
	assert.ok(addedEvt, "suggestion.added event should be emitted");
	assert.equal((addedEvt as unknown as { type: string; suggestionId: string }).suggestionId, sug!.id);

	// File content should NOT change (still pending)
	const snap2 = await readSnapshot(tmpRoot, "sug-add-pending.md");
	assert.ok(snap2!.blocks.some((b) => b.markdown.includes("Original paragraph.")), "original should remain");
});

// ── suggestion.add (pre-accepted) ────────────────────────────────────────────

test("suggestion.add with status=accepted → block replaced + 2 events", async () => {
	await writeDoc("sug-add-accepted.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "sug-add-accepted.md");
	const paraRef = snap!.blocks[1].ref;

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-add-accepted.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Auto-accepted replacement.",
			status: "accepted",
		}],
	});

	assert.ok(result.ok, `expected ok: ${JSON.stringify(result)}`);

	// Suggestion should NOT be in pending list (it's archived)
	const pending = result.ok ? result.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending suggestions after auto-accept");

	// Two events: suggestion.added + suggestion.accepted
	assert.ok(result.ok);
	const events = result.ok ? result.emittedEvents : [];
	const addedEvt = events.find((e) => e.type === "suggestion.added");
	const acceptedEvt = events.find((e) => e.type === "suggestion.accepted");
	assert.ok(addedEvt, "suggestion.added event should be emitted");
	assert.ok(acceptedEvt, "suggestion.accepted event should be emitted");
});

// ── suggestion.accept ────────────────────────────────────────────────────────

test("suggestion.accept → pending becomes accepted, block edit applied, event emitted", async () => {
	await writeDoc("sug-accept.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "sug-accept.md");
	const paraRef = snap!.blocks[1].ref;

	// Add suggestion
	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-accept.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Accepted replacement.",
		}],
	});
	assert.ok(addResult.ok, `add: ${JSON.stringify(addResult)}`);
	const sugId = addResult.ok ? addResult.snapshot.suggestions[0]?.id : null;
	assert.ok(sugId, "suggestion id must exist");

	// Accept suggestion
	const acceptResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-accept.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: sugId! }],
	});
	assert.ok(acceptResult.ok, `accept: ${JSON.stringify(acceptResult)}`);

	// No more pending suggestions
	const pending = acceptResult.ok ? acceptResult.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending after accept");

	// suggestion.accepted event emitted
	assert.ok(acceptResult.ok);
	const evt = acceptResult.ok
		? acceptResult.emittedEvents.find((e) => e.type === "suggestion.accepted")
		: null;
	assert.ok(evt, "suggestion.accepted event emitted");

	// File content updated
	const snap2 = await readSnapshot(tmpRoot, "sug-accept.md");
	assert.ok(snap2!.blocks.some((b) => b.markdown.includes("Accepted replacement.")), "block replaced");
	assert.ok(!snap2!.blocks.some((b) => b.markdown.includes("Original paragraph.")), "old block gone");
});

// ── suggestion.reject ────────────────────────────────────────────────────────

test("suggestion.reject → moved to archivedSuggestions + event, file unchanged", async () => {
	await writeDoc("sug-reject.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "sug-reject.md");
	const paraRef = snap!.blocks[1].ref;

	const addResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-reject.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{
			type: "suggestion.add",
			ref: paraRef,
			kind: "replace",
			markdown: "Rejected replacement.",
		}],
	});
	assert.ok(addResult.ok);
	const sugId = addResult.ok ? addResult.snapshot.suggestions[0]?.id : null;
	assert.ok(sugId);

	const rejectResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-reject.md",
		baseRevision: 1,
		by: "human",
		ops: [{ type: "suggestion.reject", suggestionId: sugId! }],
	});
	assert.ok(rejectResult.ok, `reject: ${JSON.stringify(rejectResult)}`);

	// No pending suggestions
	const pending = rejectResult.ok ? rejectResult.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending after reject");

	// suggestion.rejected event
	assert.ok(rejectResult.ok);
	const evt = rejectResult.ok
		? rejectResult.emittedEvents.find((e) => e.type === "suggestion.rejected")
		: null;
	assert.ok(evt, "suggestion.rejected event emitted");

	// File NOT changed
	const snap2 = await readSnapshot(tmpRoot, "sug-reject.md");
	assert.ok(snap2!.blocks.some((b) => b.markdown.includes("Original paragraph.")), "original preserved");
	assert.ok(!snap2!.blocks.some((b) => b.markdown.includes("Rejected replacement.")), "rejected text absent");
});

// ── two pending on same ref, accept one → other auto-rejected (§6.8) ─────────

test("two pending suggestions on same ref: accept one → other auto-rejected (resolvedBy: system)", async () => {
	await writeDoc("sug-conflict.md", "# Title\n\nOriginal paragraph.\n");
	const snap = await readSnapshot(tmpRoot, "sug-conflict.md");
	const paraRef = snap!.blocks[1].ref;

	// Add first suggestion
	const add1 = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-conflict.md",
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref: paraRef, kind: "replace", markdown: "Suggestion A." }],
	});
	assert.ok(add1.ok);
	const sugId1 = add1.ok ? add1.snapshot.suggestions[0]?.id : null;
	assert.ok(sugId1);

	// Add second suggestion (same ref)
	const add2 = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-conflict.md",
		baseRevision: 1,
		by: "ai:cursor",
		ops: [{ type: "suggestion.add", ref: paraRef, kind: "replace", markdown: "Suggestion B." }],
	});
	assert.ok(add2.ok);
	const sugId2 = add2.ok ? add2.snapshot.suggestions[1]?.id : null;
	assert.ok(sugId2, "second suggestion should exist");

	// Both pending
	assert.equal(add2.ok ? add2.snapshot.suggestions.length : -1, 2, "two pending");

	// Accept first
	const acceptResult = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-conflict.md",
		baseRevision: 2,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: sugId1! }],
	});
	assert.ok(acceptResult.ok, `accept: ${JSON.stringify(acceptResult)}`);

	// No pending left
	const pending = acceptResult.ok ? acceptResult.snapshot.suggestions : [];
	assert.equal(pending.length, 0, "no pending after accepting one");

	// suggestion.rejected event with reason=superseded for the second
	assert.ok(acceptResult.ok);
	const events = acceptResult.ok ? acceptResult.emittedEvents : [];
	const rejectedEvt = events.find(
		(e) => e.type === "suggestion.rejected" && (e as unknown as { suggestionId: string }).suggestionId === sugId2,
	) as { type: string; by: string; reason: string } | undefined;
	assert.ok(rejectedEvt, "rejected event for second suggestion");
	assert.equal(rejectedEvt!.by, "system", "resolvedBy should be system");
	assert.equal(rejectedEvt!.reason, "superseded");
});

// ── suggestion.accept on nonexistent ID → 409 SUGGESTION_NOT_FOUND ──────────

test("suggestion.accept on nonexistent ID → 409 SUGGESTION_NOT_FOUND", async () => {
	await writeDoc("sug-notfound.md", "# Title\n\nParagraph.\n");

	const result = await applyOps({
		rootDir: tmpRoot,
		mdPath: "sug-notfound.md",
		baseRevision: 0,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: "sdeadbeef" }],
	});

	assert.ok(!result.ok);
	assert.equal(result.ok ? "" : result.code, "SUGGESTION_NOT_FOUND");
	assert.equal(result.ok ? 0 : result.status, 409);
});
