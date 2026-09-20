/**
 * An agent-authored suggestion is a mark in the document.
 *
 * This is the property that makes one review surface possible: an agent proposing an
 * edit writes the same `<ins data-id>` / `<del data-id>` markup a human produces by
 * typing in Suggesting mode, so there is no second representation to reconcile and no
 * sidecar record that can drift from the file.
 *
 * The failure this guards against is silent and total: if the mark does not survive
 * being written to disk, the proposal reads as an applied edit on the next open — the
 * reviewer believes they are looking at a suggestion when the change has already
 * happened.
 */

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyOps, readSnapshot } from "@/lib/proof/ops-applier";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-suggestion-mark-e2e-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function doc(name: string, content: string): Promise<string> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
	return name;
}

async function paragraphRef(name: string): Promise<string> {
	const snap = await readSnapshot(tmpRoot, name);
	assert.ok(snap, "snapshot must load");
	const para = snap.blocks.find((b) => b.markdown.includes("Reactions in"));
	assert.ok(para, "fixture must contain the target paragraph");
	return para.ref;
}

test("kind=remove writes a del mark holding the removed text", async () => {
	const name = await doc("remove.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});
	assert.ok(res.ok, `op must succeed: ${JSON.stringify(res)}`);

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.match(
		onDisk,
		/<del data-id="1">app<\/del>/,
		"the removed text must still be in the file, wrapped in a deletion mark",
	);
});

test("kind=insert writes an ins mark around the supplied text", async () => {
	const name = await doc("insert.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [
			{
				type: "suggestion.add",
				ref,
				kind: "insert",
				range: { start: 13, end: 13 },
				markdown: "sometimes",
			},
		],
	});
	assert.ok(res.ok, `op must succeed: ${JSON.stringify(res)}`);

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.match(onDisk, /<ins data-id="1">sometimes<\/ins>/, "the added text must be marked");
	assert.match(onDisk, /app/, "the original text must be untouched");
});

test("the mark survives the read path, so it is still a suggestion after a reload", async () => {
	// The whole design rests on this: the .md is the only store.
	const name = await doc("reload.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);
	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});

	const reread = await readSnapshot(tmpRoot, name);
	assert.ok(reread);
	const marked = reread.blocks.find((b) => b.markdown.includes("<del data-id="));
	assert.ok(marked, "a fresh read must still see the mark");
	assert.match(marked.markdown, /<del data-id="1">app<\/del>/);
});

test("two writes get distinct ids, so they stay separately reviewable", async () => {
	// Reusing an id would merge the two proposals into one, and the vendored library
	// treats id as suggestion identity.
	const name = await doc("two.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);
	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});

	// Re-read before computing the second range: the first mark changed the block's
	// markdown, so an offset computed against the original text no longer addresses
	// the same characters.
	const snap = await readSnapshot(tmpRoot, name);
	const block = snap!.blocks.find((b) => b.markdown.includes("slow"))!;
	const start2 = block.markdown.indexOf("slow");
	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [
			{
				type: "suggestion.add",
				ref: block.ref,
				kind: "remove",
				range: { start: start2, end: start2 + 4 },
			},
		],
	});
	assert.ok(res.ok, `second op must succeed: ${JSON.stringify(res)}`);

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.match(onDisk, /data-id="1"/, "the first suggestion keeps its id");
	assert.match(onDisk, /data-id="2"/, "the second gets the next id, so both stay reviewable");
	assert.match(onDisk, /<del data-id="1">app<\/del>/, "the first mark must survive intact");
});

test("a STALE range is refused instead of corrupting the earlier mark", async () => {
	// The bug this pins, measured: a caller that computed its offset before the first
	// mark was written pointed into that mark's own tag, and the splice split the tag
	// in half, producing `<del da<del data-id="2">ta-i</del>d="1">app</del>` — which
	// both corrupts the tag and loses the first suggestion. A range inside a tag is
	// never intended, so it is refused and the caller re-reads.
	const name = await doc("stale.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);
	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});
	const afterFirst = await readFile(path.join(tmpRoot, name), "utf-8");

	// 20 was the offset of "slow" in the ORIGINAL text. After the first mark it lands
	// inside `<del data-id="1">`. The ref is taken fresh, so this reaches the range
	// check rather than tripping the (also correct) ref-changed check first.
	const snap = await readSnapshot(tmpRoot, name);
	const freshRef = snap!.blocks.find((b) => b.markdown.includes("slow"))!.ref;
	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref: freshRef, kind: "remove", range: { start: 20, end: 24 } }],
	});
	assert.equal(res.ok, false, "a stale range must be refused");
	if (!res.ok) {
		// The guard tightened from "is this position inside a tag" to full interval
		// containment, so a range that spans part of a tag is now reported as an
		// overlap. Both codes mean refused; the specific code is pinned by the
		// boundary tests in suggestion-mark.test.ts.
		assert.ok(
			res.code === "RANGE_IN_MARK" || res.code === "RANGE_OVERLAPS_MARK",
			`expected a refusal, got ${res.code}`,
		);
		assert.match(res.message, /re-read/i, "the message must say how to recover");
	}

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.equal(onDisk, afterFirst, "the file must be byte-identical after a refusal");
	assert.doesNotMatch(onDisk, /<del da</, "the mark tag must not be split");
});

test("a stale ref is refused too, which is the first line of defence", async () => {
	// Ranges and refs are both content-derived, so both invalidate when a mark lands.
	// The ref check fires first in practice; this pins that it does, so an agent
	// holding pre-edit identifiers is told to re-read rather than writing blind.
	const name = await doc("stale-ref.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);
	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});
	const afterFirst = await readFile(path.join(tmpRoot, name), "utf-8");

	const snap = await readSnapshot(tmpRoot, name);
	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 0, end: 5 } }],
	});
	assert.equal(res.ok, false);
	if (!res.ok) assert.equal(res.code, "BLOCK_NOT_FOUND");
	assert.equal(await readFile(path.join(tmpRoot, name), "utf-8"), afterFirst);
});

test("a mark is content: the revision advances", async () => {
	// Unlike comment.add, which is annotation-only. A mark changes the file's bytes,
	// so an editor holding the old revision must be made to reload rather than
	// silently overwrite the proposal.
	const name = await doc("rev.md", "Intro.\n\nReactions in app are slow.\n");
	const before_ = await readSnapshot(tmpRoot, name);
	const ref = await paragraphRef(name);

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: before_!.revision,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 13, end: 16 } }],
	});
	assert.ok(res.ok);

	const after_ = await readSnapshot(tmpRoot, name);
	assert.ok(
		after_!.revision > before_!.revision,
		`revision must advance (was ${before_!.revision}, now ${after_!.revision})`,
	);
});

test("status=accepted is refused, naming the ops that do apply a change", async () => {
	// The old branch mapped these kinds onto a block op and applied them inline. That
	// is what block.* is for; silently accepting the flag would apply an edit the
	// caller believes is a pending suggestion.
	const name = await doc("accepted.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [
			{
				type: "suggestion.add",
				ref,
				kind: "replace",
				markdown: "Rewritten.",
				status: "accepted",
			} as never,
		],
	});

	assert.equal(res.ok, false, "status=accepted must not be honoured");
	if (!res.ok) {
		assert.equal(res.code, "UNSUPPORTED_SUGGESTION_STATUS");
		assert.match(res.message, /block\.replace/, "the message must name what to post instead");
	}
	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.match(onDisk, /Reactions in app are slow/, "the file must be untouched");
});

test("a range outside the block is refused rather than clamped", async () => {
	const name = await doc("oob.md", "Intro.\n\nReactions in app are slow.\n");
	const ref = await paragraphRef(name);

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: 0,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref, kind: "remove", range: { start: 5, end: 900 } }],
	});
	assert.equal(res.ok, false);
	if (!res.ok) assert.equal(res.code, "RANGE_OUT_OF_BOUNDS");

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.doesNotMatch(onDisk, /data-id/, "no mark may be written on a refusal");
});
test("marks in DIFFERENT blocks get distinct ids, in one write", async () => {
	// Found by review, and it is the worst class of bug here: ids were allocated per
	// block, so two paragraphs each started at 1. The editor groups marks by id across
	// the WHOLE document, so those two independent suggestions collapsed into a single
	// review card, and settling it settled both ranges. Measured before the fix:
	// `<del data-id="1">alpha</del>` and `<del data-id="1">beta</del>`.
	const name = await doc("crossblock.md", "# Title\n\nalpha thing\n\nbeta thing\n");
	const snap = await readSnapshot(tmpRoot, name);
	const refs = snap!.blocks.filter((b) => b.markdown.includes("thing")).map((b) => b.ref);
	assert.equal(refs.length, 2, "fixture needs two separate blocks");

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [
			{ type: "suggestion.add", ref: refs[0], kind: "remove", range: { start: 0, end: 5 } },
			{ type: "suggestion.add", ref: refs[1], kind: "remove", range: { start: 0, end: 4 } },
		],
	});
	assert.ok(res.ok, `op must succeed: ${JSON.stringify(res)}`);

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.match(onDisk, /<del data-id="1">alpha<\/del>/, "the first block's mark");
	assert.match(onDisk, /<del data-id="2">beta<\/del>/, "the second block's mark");
	const ids = [...onDisk.matchAll(/data-id="(\d+)"/g)].map((m) => m[1]);
	assert.equal(
		new Set(ids).size,
		ids.length,
		`every mark needs its own id or the editor merges them; got ${ids.join(", ")}`,
	);
});

test("a mark's id clears marks in every block, not only its own", async () => {
	// The narrower statement of the same rule: a document whose highest id sits in an
	// EARLIER block must still hand the next mark a higher one.
	const name = await doc("maxspan.md", "# Title\n\nalpha thing\n\nbeta thing\n");
	const snap = await readSnapshot(tmpRoot, name);
	const refs = snap!.blocks.filter((b) => b.markdown.includes("thing")).map((b) => b.ref);

	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref: refs[0], kind: "remove", range: { start: 0, end: 5 } }],
	});
	const afterFirst = await readSnapshot(tmpRoot, name);
	const ref2 = afterFirst!.blocks.find((b) => b.markdown.includes("beta"))!.ref;
	await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: afterFirst!.revision,
		by: "ai:claude",
		ops: [{ type: "suggestion.add", ref: ref2, kind: "remove", range: { start: 0, end: 4 } }],
	});

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	const ids = [...onDisk.matchAll(/data-id="(\d+)"/g)].map((m) => m[1]);
	assert.deepEqual(ids, ["1", "2"], "the second mark must not reuse id 1");
});

test("a legacy block-level kind is refused, not turned into an insertion", async () => {
	// `kind: "delete"` used to be mapped to `insert`, so an old client asking to delete
	// a block got an INSERTION mark proposing the opposite change. A mark covers a run
	// of text, so a whole-block edit has to be a block op.
	const name = await doc("legacy-kind.md", "abc\n");
	const snap = await readSnapshot(tmpRoot, name);
	const ref = snap!.blocks[0].ref;

	for (const kind of ["delete", "replace", "insertAfter", "insertBefore"]) {
		const res = await applyOps({
			rootDir: tmpRoot,
			mdPath: name,
			baseRevision: snap!.revision,
			by: "ai:claude",
			ops: [{ type: "suggestion.add", ref, kind, range: { start: 0, end: 1 }, markdown: "ZZ" } as never],
		});
		assert.equal(res.ok, false, `kind=${kind} must be refused`);
		if (!res.ok) assert.equal(res.code, "UNSUPPORTED_SUGGESTION_KIND");
	}

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.equal(onDisk, "abc\n", "a refused op must not touch the file");
});

test("garbage inside the marked text is refused rather than written", async () => {
	const name = await doc("badtext.md", "before after.\n");
	const snap = await readSnapshot(tmpRoot, name);
	const ref = snap!.blocks[0].ref;

	for (const bad of ["x</ins>y", "a\n\nsecond"]) {
		const res = await applyOps({
			rootDir: tmpRoot,
			mdPath: name,
			baseRevision: snap!.revision,
			by: "ai:claude",
			ops: [{ type: "suggestion.add", ref, kind: "insert", range: { start: 7, end: 7 }, markdown: bad }],
		});
		assert.equal(res.ok, false, `${JSON.stringify(bad)} must be refused`);
		if (!res.ok) assert.equal(res.code, "INVALID_TEXT");
	}

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.equal(onDisk, "before after.\n", "a refused op must not touch the file");
});

test("a failed batch reports the file on disk, not the ops it did not write", async () => {
	// `workingBlocks` is mutated op by op while the file is written only after the whole
	// loop succeeds. A mid-batch failure therefore used to return a snapshot containing
	// the earlier ops' marks while the file was byte-identical to before - a caller that
	// trusted it would believe a suggestion existed that no reader could see.
	//
	// Here the second op cannot resolve, because the first splice changed the block's
	// content-derived ref.
	const name = await doc("failed-batch.md", "First alpha beta.\n");
	const snap = await readSnapshot(tmpRoot, name);
	const ref = snap!.blocks[0].ref;

	const res = await applyOps({
		rootDir: tmpRoot,
		mdPath: name,
		baseRevision: snap!.revision,
		by: "ai:claude",
		ops: [
			{ type: "suggestion.add", ref, kind: "remove", range: { start: 6, end: 11 } },
			{ type: "suggestion.add", ref, kind: "remove", range: { start: 12, end: 16 } },
		],
	});

	assert.equal(res.ok, false, "the second op cannot resolve the pre-splice ref");
	if (!res.ok) assert.equal(res.code, "BLOCK_NOT_FOUND");

	const onDisk = await readFile(path.join(tmpRoot, name), "utf-8");
	assert.equal(onDisk, "First alpha beta.\n", "a failed batch must not write");

	const reported = res.snapshot!.blocks.map((b) => b.markdown).join("\n");
	assert.ok(
		!reported.includes("<del"),
		`the snapshot must not describe a mark that was never written; got ${JSON.stringify(reported)}`,
	);
	assert.match(reported, /First alpha beta\./, "it reports what is actually persisted");
});
