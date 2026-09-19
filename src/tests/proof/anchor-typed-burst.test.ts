import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { Anchor, Block, Sidecar, Suggestion } from "@/lib/proof/types";
import { anchorForBlock, anchorForRange, resolveAnchor } from "@/lib/proof/anchor";

/**
 * Spec case 8: a keystroke burst produces one durable suggestion and zero 409s.
 *
 * The identity half of that is tested here. The revision half is already guarded by
 * `f9-revision-adoption` and `f10-snapshot-monotonic`, which pass today; the spec's own
 * "what this does not fix" section forbids claiming that single-writer revision repairs
 * the unexplained base-0 report, so it is not re-tested here.
 *
 * The failure this locks down was reported live: typing in Suggesting mode made the
 * suggestions disappear. Refs are content-derived, so the first keystroke that changed
 * the block's text killed the suggestion's ref, and a suggestion that cannot be placed
 * cannot be continued, accepted, or rendered.
 */

const NOW = "2026-09-19T00:00:00.000Z";

function sc(blocks: Block[], anchors: Record<string, Anchor>, suggestions: Suggestion[]): Sidecar {
	const refMap: Record<string, { textHash: string; lastSeenAt: string }> = {};
	for (const b of blocks) refMap[b.ref] = { textHash: `h${b.ref}`, lastSeenAt: NOW };
	return {
		schemaVersion: 3,
		path: "d.md",
		revision: 3,
		createdAt: NOW,
		updatedAt: NOW,
		refMap,
		refAliases: {},
		anchors,
		comments: [],
		suggestions,
		archivedSuggestions: [],
		events: [],
		nextEventId: 1,
		lastAck: {},
		fingerprint: "",
	};
}

describe("a typed suggestion survives its block's ref changing", () => {
	test("the anchor keeps resolving after the block text is rewritten", () => {
		// The user types into "Alpha paragraph here.", so the run's block gains text and
		// its ref changes — this is the first keystroke of the burst.
		const before: Block[] = [{ ref: "bAAA111", type: "paragraph", markdown: "Alpha paragraph here." }];
		const anchor = anchorForRange(before[0].markdown, before[0].ref, 17, 0, NOW);
		const suggestion: Suggestion = {
			id: "s1",
			ref: before[0].ref,
			anchorId: anchor.id,
			kind: "insert",
			status: "pending",
			by: "human",
			markdown: "X",
			range: { start: 17, end: 17 },
			createdAt: NOW,
		};
		const sidecar = sc(before, { [anchor.id]: anchor }, [suggestion]);

		// The edit that follows changes the block's text, so its ref is gone.
		const after: Block[] = [{ ref: "bZZZ999", type: "paragraph", markdown: "Alpha paragraph here.X" }];
		assert.notEqual(after[0].ref, before[0].ref, "the ref really did change");

		const r = resolveAnchor(sidecar, anchor, after);
		assert.ok(r.ref, "the suggestion is still placeable");
		assert.equal(r.ref, after[0].ref, "and it follows the block to its new ref");
	});

	test("a block-granular suggestion follows a pure insertion above", () => {
		const before: Block[] = [{ ref: "bAAA111", type: "paragraph", markdown: "Alpha paragraph here." }];
		const anchor = anchorForBlock(before[0].markdown, before[0].ref, NOW);
		const sidecar = sc(before, { [anchor.id]: anchor }, []);
		// A run that appends to the block: ref changes, text is a superset.
		const after: Block[] = [{ ref: "bCCC333", type: "paragraph", markdown: "Alpha paragraph here. more" }];
		const r = resolveAnchor(sidecar, anchor, after);
		assert.equal(r.status, "moved", "the whole-block anchor follows the block");
		assert.equal(r.ref, after[0].ref);
	});

	test("a suggestion whose quote is gone is lost, not silently relocated", () => {
		const before: Block[] = [{ ref: "bAAA111", type: "paragraph", markdown: "Alpha paragraph here." }];
		const anchor = anchorForRange(before[0].markdown, before[0].ref, 0, 5, NOW);
		const sidecar = sc(before, { [anchor.id]: anchor }, []);
		const after: Block[] = [{ ref: "bZZZ999", type: "paragraph", markdown: "Entirely different." }];
		const r = resolveAnchor(sidecar, anchor, after);
		assert.equal(r.status, "lost");
		assert.equal(r.ref, null, "no guessed placement");
	});

	test("resolving a suggestion does not mutate the anchor it used", () => {
		const before: Block[] = [{ ref: "bAAA111", type: "paragraph", markdown: "Alpha paragraph here." }];
		const anchor = anchorForRange(before[0].markdown, before[0].ref, 6, 9, NOW);
		const snapshot = { ...anchor };
		const sidecar = sc(before, { [anchor.id]: anchor }, []);
		resolveAnchor(sidecar, anchor, [{ ref: "bZZZ999", type: "paragraph", markdown: "X Alpha paragraph here." }]);
		assert.deepEqual(sidecar.anchors[anchor.id], snapshot, "a read must not move the anchor");
	});
});
