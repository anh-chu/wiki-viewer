/**
 * Deleting one of two identical paragraphs must not cancel the comment on the other.
 *
 * Refs are content-derived, so two blocks with the same text are different blocks that
 * happen to share a hash: the first takes `b<sha>`, the second `b<sha>_1`. Delete the
 * first and the survivor reclaims `b<sha>` while `b<sha>_1` disappears from the refMap.
 * A comment anchored to `b<sha>_1` then looks orphaned although its text is untouched,
 * and cancellation is one-way — there is no un-cancel path — so the annotation is lost
 * for good.
 *
 * Found by an independent reviewer, reproduced here, then fixed by honouring the
 * `refAliases` that `computeRefDelta` already computes. Duplicate paragraphs are
 * ordinary in real documents (repeated bullets, "Notes" headings, placeholder lines),
 * so this was reachable by deleting any one of them.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assignRefs } from "@/lib/proof/block-refs";
import { parseBlocks } from "@/lib/proof/blocks";
import { reconcileRefsAndCancelOrphans } from "@/lib/proof/ops-applier";
import { emptySidecar } from "@/lib/proof/sidecar";

/** A sidecar anchored to the block at `index` of `markdown`. */
function anchored(markdown: string, index: number) {
	const { newRefMap } = assignRefs(parseBlocks(markdown), null);
	const sc = emptySidecar("d.md");
	sc.refMap = newRefMap;
	const ref = Object.keys(newRefMap)[index];
	sc.comments.push({
		id: "c1",
		ref,
		body: "anchored here",
		createdAt: new Date().toISOString(),
		resolved: false,
	} as never);
	return { sc, ref };
}

const cancelReason = (sc: { comments: unknown[] }) =>
	(sc.comments[0] as { cancelReason?: string }).cancelReason;
const resolved = (sc: { comments: unknown[] }) =>
	(sc.comments[0] as { resolved: boolean }).resolved;

describe("duplicate blocks do not orphan each other", () => {
	test("two identical paragraphs get distinct refs", () => {
		// The premise. If this ever collapses to one ref the cases below stop meaning
		// anything, so it is asserted rather than assumed.
		const { newRefMap } = assignRefs(parseBlocks("Same.\n\nSame.\n\nOther.\n"), null);
		const refs = Object.keys(newRefMap);
		assert.equal(refs.length, 3);
		assert.equal(new Set(refs).size, 3, "each block has its own ref");
	});

	test("deleting the FIRST duplicate keeps the comment on the second", () => {
		const { sc, ref } = anchored("Same.\n\nSame.\n\nOther.\n", 1);
		assert.equal(ref.endsWith("_1"), true, "the second duplicate carries the suffixed ref");

		reconcileRefsAndCancelOrphans(sc, "Same.\n\nOther.\n");

		assert.equal(resolved(sc), false, "its text is still in the document");
		assert.equal(cancelReason(sc), undefined);
	});

	test("deleting the first of THREE duplicates keeps the comment on the third", () => {
		const { sc } = anchored("Same.\n\nSame.\n\nSame.\n\nOther.\n", 2);
		reconcileRefsAndCancelOrphans(sc, "Same.\n\nSame.\n\nOther.\n");
		assert.equal(resolved(sc), false);
	});

	test("adding a duplicate does not disturb an existing anchor", () => {
		const { sc } = anchored("Same.\n\nSame.\n\nOther.\n", 1);
		reconcileRefsAndCancelOrphans(sc, "Same.\n\nSame.\n\nSame.\n\nOther.\n");
		assert.equal(resolved(sc), false);
	});

	test("CONTROL: genuinely deleted text IS still cancelled", () => {
		// The fix must not blunt orphan detection — that defect is the reason this
		// function exists at all, and three margin cards once pointed at nothing.
		const { sc } = anchored("Kept.\n\nGone.\n", 1);
		reconcileRefsAndCancelOrphans(sc, "Kept.\n");
		assert.equal(resolved(sc), true, "its text is gone, so it is cancelled");
		assert.equal(cancelReason(sc), "anchor-lost");
	});

	test("CONTROL: the two outcomes differ only by whether the text survives", () => {
		// Both start from the same shape; one loses its text and one loses a duplicate.
		const deleted = anchored("Same.\n\nSame.\n\nOther.\n", 1);
		reconcileRefsAndCancelOrphans(deleted.sc, "Same.\n\nOther.\n");
		const duplicated = anchored("Same.\n\nSame.\n\nOther.\n", 1);
		reconcileRefsAndCancelOrphans(duplicated.sc, "Same.\n\nOther.\n\nSame.\n");
		assert.equal(resolved(deleted.sc), false, "same text still present");
		assert.equal(resolved(duplicated.sc), false, "same text still present");
	});
});
