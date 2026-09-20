/**
 * EMPIRICAL INVESTIGATION — sibling orphaning on suggestion accept.
 *
 * Hypothesis under test:
 *   "Accepting one of three pending suggestions on the same block orphans the
 *    other two" — i.e. S2/S3 are left `pending`+`stale:true` (invisible via
 *    suggestion-decorator.ts:85) rather than being resolved.
 *
 * Findings (see test names): the hypothesis is FALSE for the accept path,
 * because suggestion.accept explicitly supersedes same-ref siblings
 * (ops-applier.ts:956-973) BEFORE the block op changes the content.
 *
 * Convention chosen: this repo documents CURRENT behaviour in passing tests
 * (e.g. reconcile-sidecar.test.ts asserts the stale-marking that exists today).
 * So the primary tests below assert the real, current behaviour and PASS, and
 * each carries an explicit "this documents current behaviour" label.
 *
 * The stale-orphaning mechanism itself is real, but it is reached through the
 * EXTERNAL-EDIT path (reconcileSidecar → markOrphanedRefsStale), not through
 * accept. That is reproduced in the last test so the mechanism is pinned down.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { applyOps, readSnapshot, reconcileSidecar } from "../../lib/proof/ops-applier.js";
import { emptySidecar, readSidecar } from "../../lib/proof/sidecar.js";
import { assignRefs } from "../../lib/proof/block-refs.js";
import { parseBlocks } from "../../lib/proof/blocks.js";
import type { Suggestion } from "../../lib/proof/types.js";

let tmpRoot: string;

before(async () => {
	tmpRoot = await mkdtemp(path.join(tmpdir(), "wiki-anchor-sibling-test-"));
});

after(async () => {
	await rm(tmpRoot, { recursive: true, force: true });
});

async function writeDoc(name: string, content: string): Promise<void> {
	await writeFile(path.join(tmpRoot, name), content, "utf-8");
}

async function readDoc(name: string): Promise<string> {
	return readFile(path.join(tmpRoot, name), "utf-8");
}

function sha256(content: string): string {
	return "sha256:" + createHash("sha256").update(content, "utf-8").digest("hex");
}

/** Three reviewers each propose different wording for the same paragraph. */
const DOC = "# Release Notes\n\nThe rollout is planned for next week.\n";
const PROPOSALS = [
	"Three reviewers propose: the rollout is planned for next week, subject to sign-off.",
	"Three reviewers propose: the rollout is scheduled for next week pending QA.",
	"Three reviewers propose: we intend to roll out next week if the canary holds.",
];

/**
 * Build a doc + three pending suggestions all anchored to the SAME block ref.
 * Returns { ref, ids } where ids[0] is the one a human will accept.
 */
async function seedThreeSiblings(
	mdPath: string,
): Promise<{ ref: string; ids: [string, string, string] }> {
	await writeDoc(mdPath, DOC);
	const snap = await readSnapshot(tmpRoot, mdPath);
	assert.ok(snap, "snapshot");
	const ref = snap!.blocks[1].ref;

	let revision = snap!.revision;
	for (let i = 0; i < 3; i++) {
		const res = await applyOps({
			rootDir: tmpRoot,
			mdPath,
			baseRevision: revision,
			by: `ai:reviewer-${i + 1}`,
			ops: [
				{
					type: "suggestion.add",
					ref,
					kind: "replace",
					markdown: PROPOSALS[i],
					baseMarkdown: snap!.blocks[1].markdown,
				},
			],
		});
		assert.ok(res.ok, `suggestion.add #${i + 1}: ${JSON.stringify(res)}`);
		revision = res.ok ? res.snapshot.revision : revision;
	}

	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar");
	assert.equal(sidecar!.suggestions.length, 3, "three siblings seeded");
	for (const s of sidecar!.suggestions) {
		assert.equal(s.ref, ref, "all three siblings anchor to the same ref");
		assert.equal(s.status, "pending");
		assert.equal(s.stale, undefined, "seeded siblings are not stale");
	}

	return { ref, ids: sidecar!.suggestions.map((s) => s.id) as [string, string, string] };
}

// ── 1. Suggestion level: accept S1, what happens to S2/S3? ───────────────────

test("CURRENT BEHAVIOUR (documents today, not desired): accepting S1 resolves S2/S3 as rejected+superseded — they are NOT left pending/stale", async () => {
	const mdPath = "siblings-suggestion.md";
	const { ref, ids } = await seedThreeSiblings(mdPath);

	const accept = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: ids[0] }],
	});
	assert.ok(accept.ok, `accept: ${JSON.stringify(accept)}`);

	// ── The claimed bug would show up here as `stale: true` siblings. ──────────
	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar after accept");

	// 1. No sibling is left pending at all.
	const stillPending = sidecar!.suggestions.filter(
		(s) => s.id === ids[1] || s.id === ids[2],
	);
	assert.equal(
		stillPending.length,
		0,
		`S2/S3 must not be left pending (the claimed orphaning): ${JSON.stringify(stillPending)}`,
	);

	// 2. No sibling carries stale:true.
	const staleSiblings = sidecar!.archivedSuggestions.filter(
		(s) => (s.id === ids[1] || s.id === ids[2]) && s.stale === true,
	);
	assert.equal(
		staleSiblings.length,
		0,
		`S2/S3 must not be marked stale: ${JSON.stringify(staleSiblings)}`,
	);

	// 3. They were deliberately rejected with reason=superseded, by system.
	for (const id of [ids[1], ids[2]]) {
		const archived: Suggestion | undefined = sidecar!.archivedSuggestions.find((s) => s.id === id);
		assert.ok(archived, `${id} should be archived, not dropped`);
		assert.equal(archived!.status, "rejected", `${id} status`);
		assert.equal(archived!.resolvedBy, "system", `${id} resolvedBy`);
	}

	const supersededEvents = accept.ok
		? accept.emittedEvents.filter(
				(e) =>
					e.type === "suggestion.rejected" &&
					(e as unknown as { reason?: string }).reason === "superseded",
			)
		: [];
	assert.equal(supersededEvents.length, 2, "two superseded events emitted");

	// 4. Accepted body applied; the original ref is genuinely gone.
	const content = await readDoc(mdPath);
	assert.ok(content.includes(PROPOSALS[0]), "S1 applied to the document");
	assert.ok(!(ref in sidecar!.refMap), "old ref dropped from refMap after content change");

	// 5. CORRECTION TO THE PRIOR RESEARCH: an alias IS recorded for the changed
	//    block. computeRefDelta alone would not produce one (it only aliases on an
	//    exact textHash match — block-refs.ts:120-128), but block.replace records it
	//    UNCONDITIONALLY at ops-applier.ts:605 (`collectedAliases[oldRef] = newRefs[0]`),
	//    and that map overwrites the computed delta at ops-applier.ts:1027/1039.
	const newRef = accept.ok
		? accept.snapshot.blocks.find((b) => b.markdown === PROPOSALS[0])?.ref
		: undefined;
	assert.ok(newRef, "the accepted proposal is a block in the new snapshot");
	assert.equal(
		sidecar!.refAliases[ref],
		newRef,
		"block.replace DOES alias the old ref to the replacement (ops-applier.ts:605)",
	);
});

// ── 2. Comment level: comment on the same block alongside the accepted S1 ────

test("CURRENT BEHAVIOUR (documents today, not desired): a comment on the same block survives accept; it is NOT marked stale", async () => {
	const mdPath = "siblings-comment.md";
	const { ref, ids } = await seedThreeSiblings(mdPath);

	// A comment anchored to the very same block.
	const addComment = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "comment.add", ref, text: "Can we hold this until legal signs off?" }],
	});
	assert.ok(addComment.ok, `comment.add: ${JSON.stringify(addComment)}`);
	const commentId = addComment.ok ? addComment.snapshot.comments[0]?.id : null;
	assert.ok(commentId, "comment id");

	const accept = await applyOps({
		rootDir: tmpRoot,
		mdPath,
		baseRevision: 0,
		by: "human",
		ops: [{ type: "suggestion.accept", suggestionId: ids[0] }],
	});
	assert.ok(accept.ok, `accept: ${JSON.stringify(accept)}`);

	const sidecar = await readSidecar(tmpRoot, mdPath);
	const comment = sidecar!.comments.find((c) => c.id === commentId);
	assert.ok(comment, "comment survives the accept");
	assert.equal(comment!.resolved, false, "comment still open");
	assert.equal(
		comment!.stale,
		undefined,
		`comment was marked stale by markOrphanedRefsStale (!c.resolved && c.ref && !validRefs.has(c.ref)): ${JSON.stringify(comment)}`,
	);
	assert.equal(
		comment!.ref,
		ref,
		"comment is left pointing at the now-dead ref, but is unflagged — silent dangling anchor",
	);
});

// ── 3. The stale mechanism that DOES exist: external write / raw overwrite ───

test("MECHANISM IS REAL, PATH IS DIFFERENT: reconcileSidecar (external edit) DOES orphan pending siblings with stale:true", async () => {
	const mdPath = "siblings-external.md";
	const { ref } = await seedThreeSiblings(mdPath);

	// Somebody rewrites the paragraph outside block-ops (external editor / raw write).
	const rewritten = "# Release Notes\n\nThe rollout slipped to next quarter.\n";
	await writeDoc(mdPath, rewritten);

	const sidecar = await readSidecar(tmpRoot, mdPath);
	assert.ok(sidecar, "sidecar");
	sidecar!.fingerprint = sha256("stale pre-edit fingerprint");
	await reconcileSidecar({
		rootDir: tmpRoot,
		mdPath,
		content: rewritten,
		sidecar: sidecar!,
		by: "system",
		eventType: "file.externallyEdited",
		fingerprint: sha256(rewritten),
	});

	const orphaned = sidecar!.suggestions.filter((s) => s.ref === ref);
	assert.equal(orphaned.length, 3, "all three siblings still present (not superseded)");
	for (const s of orphaned) {
		assert.equal(s.status, "pending", "still pending — no accept ran");
		assert.equal(
			s.stale,
			true,
			`orphaned pending sibling should be stale: ${JSON.stringify(s)}`,
		);
	}

	// And the resulting behaviour the UI sees: the decorator skips them, so they
	// vanish from rendering while remaining "pending" in the sidecar.
	const sidecar2 = await readSidecar(tmpRoot, mdPath);
	const rendered = sidecar2!.suggestions.filter((s) => s.status === "pending" && !s.stale);
	assert.equal(rendered.length, 0, "no pending+non-stale suggestion is rendered");
	assert.equal(
		sidecar2!.suggestions.length,
		3,
		"...yet three pending suggestions still sit in the sidecar (the real silent-drop)",
	);
});

// ── 4. Unit-level control: assignRefs mints a NEW ref when text changes ──────

test("CONTROL: assignRefs mints a new ref for changed text; computeRefDelta's hash-match rule alone would not alias it", () => {
	const before = parseBlocks(DOC);
	const { blocks: beforeBlocks, newRefMap } = assignRefs(before, null);
	const oldRef = beforeBlocks[1].ref;

	const after = parseBlocks(`# Release Notes\n\n${PROPOSALS[0]}\n`);
	const { blocks: afterBlocks, newRefMap: afterMap } = assignRefs(after, {
		...emptySidecar("unit.md"),
		refMap: newRefMap,
	});

	assert.notEqual(afterBlocks[1].ref, oldRef, "changed text → new ref");
	assert.equal(afterBlocks[0].ref, beforeBlocks[0].ref, "untouched heading keeps its ref");
	assert.ok(!(oldRef in afterMap), "old ref absent from the new refMap");
});