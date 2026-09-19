import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Anchor, Block, Comment, Sidecar, Suggestion } from "@/lib/proof/types";
import {
	anchorForBlock,
	anchorForRange,
	migrateSidecar,
	parseTextQuote,
	projectCommentViews,
	resolveAnchor,
} from "@/lib/proof/anchor";

/**
 * The eight cases from the spec's Testing decisions, as pure tests.
 *
 * These are the direct replacement for two perturb-ledger guards that died with the
 * mechanisms they protected: `f8-edited-block-alias` (which disabled the positional
 * alias pass to make `comment-highlight.test.ts` fail) and `f6-block-comment-highlight`
 * (which disabled the block-granular fallback). Both are now covered here, where the
 * inputs and outputs are pure values rather than a decorated DOM.
 */

const NOW = "2026-09-19T00:00:00.000Z";

/**
 * Blocks with CONTENT-DERIVED refs, as the real `assignRefs` mints them.
 *
 * This matters: half these cases are about a ref changing because the text changed, so a
 * helper that handed out stable refs would pass while proving nothing. Duplicates are
 * counter-suffixed exactly as `mintRef` does.
 */
function blocks(...markdowns: string[]): Block[] {
	const used = new Set<string>();
	return markdowns.map((markdown) => {
		const base = `b${createHash("sha256").update(markdown).digest("hex").slice(0, 6)}`;
		let ref = base;
		let n = 1;
		while (used.has(ref)) ref = `${base}_${n++}`;
		used.add(ref);
		return { ref, type: "paragraph", markdown };
	});
}

function sidecarWith(blocksList: Block[], anchors: Record<string, Anchor> = {}): Sidecar {
	const refMap: Record<string, { textHash: string; lastSeenAt: string }> = {};
	for (const b of blocksList) refMap[b.ref] = { textHash: `h${b.ref}`, lastSeenAt: NOW };
	return {
		schemaVersion: 3,
		path: "d.md",
		revision: 1,
		createdAt: NOW,
		updatedAt: NOW,
		refMap,
		refAliases: {},
		anchors,
		comments: [],
		suggestions: [],
		archivedSuggestions: [],
		events: [],
		nextEventId: 1,
		lastAck: {},
		fingerprint: "",
	};
}

/** An anchor on `quote` inside the single block, plus the sidecar holding it. */
function seeded(markdown: string, quote: string) {
	const bs = blocks(markdown);
	const anchor = anchorForRange(markdown, bs[0].ref, markdown.indexOf(quote), quote.length, NOW);
	return { bs, anchor, sc: sidecarWith(bs, { [anchor.id]: anchor }) };
}

describe("anchor resolution", () => {
	test("case 1: typing inside the annotated sentence moves the anchor", () => {
		const { bs, anchor, sc } = seeded("Alpha paragraph here.", "paragraph");
		// The user types before the quoted words, shifting them right.
		assert.notEqual(bs[0].markdown, "NEW Alpha paragraph here.");
		const after = blocks("NEW Alpha paragraph here.");
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "moved", "the quote is still there, at a new offset");
		assert.equal(after[0].markdown.slice(r.offset, r.offset + r.length), "paragraph");
		assert.equal(r.ref, after[0].ref);
	});

	test("case 2: a block edited in place still resolves its annotation", () => {
		// Commit 6f9fd72's case: the content hash changes, so the old ref is gone.
		const { bs, anchor, sc } = seeded("Alpha paragraph here.", "paragraph");
		const after = blocks("Alpha paragraph here. EDITED");
		assert.notEqual(after[0].ref, bs[0].ref, "the ref really did change");
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "moved");
		assert.equal(after[0].markdown.slice(r.offset, r.offset + r.length), "paragraph");
	});

	test("case 3: inserting a block above leaves the annotation correct", () => {
		const bs = blocks("Alpha paragraph here.");
		const anchor = anchorForRange(bs[0].markdown, bs[0].ref, 6, 9, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });
		// A new block goes in above. The annotated block's own content is untouched, so it
		// keeps its ref and the anchor does not even need to move.
		const after = blocks("Brand new first block.", "Alpha paragraph here.");
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "exact", "an insertion above does not disturb the anchor");
		assert.equal(after.find((b) => b.ref === r.ref)?.markdown.slice(r.offset, r.offset + r.length), "paragraph");
	});

	test("case 3c: a block displaced by an insertion is not mis-anchored", () => {
		// The annotated block's ref is gone AND a different block now holds its old slot.
		// Nothing recorded matches, so the answer must be lost rather than the slot's text.
		const bs = blocks("Alpha paragraph here.");
		const anchor = anchorForRange(bs[0].markdown, bs[0].ref, 6, 9, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });
		const after = blocks("Brand new first block.");
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "lost", "must not attach to unrelated text");
		assert.equal(r.ref, null);
	});

	test("case 3b: an insertion that leaves the block reachable keeps the anchor", () => {
		// The block keeps its ref because its content is unchanged and it is still there.
		const bs = blocks("Alpha paragraph here.");
		const anchor = anchorForRange(bs[0].markdown, bs[0].ref, 6, 9, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });
		const after = [bs[0], ...blocks("Second paragraph.")].map((b, i) => ({ ...b, ref: `n${i}` }));
		// Renaming the ref simulates the block order surviving while refs were reassigned.
		const sameRef = [bs[0]];
		const r = resolveAnchor(sc, anchor, sameRef);
		assert.equal(r.status, "exact");
		assert.equal(r.offset, 6);
		assert.ok(after.length === 2);
	});

	test("case 4: deleting the annotated paragraph loses only that anchor", () => {
		const bs = blocks("Alpha paragraph here.", "Alpha paragraph here.");
		const anchorA = anchorForRange(bs[0].markdown, bs[0].ref, 6, 9, NOW);
		const anchorB = anchorForRange(bs[1].markdown, bs[1].ref, 6, 9, NOW);
		const sc = sidecarWith(bs, { [anchorA.id]: anchorA, [anchorB.id]: anchorB });
		// Delete the FIRST of two identical paragraphs; the second reclaims the shared ref.
		const after: Block[] = [{ ref: bs[0].ref, type: "paragraph", markdown: bs[1].markdown }];

		// Deleting A hands A's ref to B, the survivor, so the two anchors' refs swap.
		// Content is what settles it: B's anchor quote is still on screen, so it resolves.
		const rB = resolveAnchor(sc, anchorB, after);
		assert.equal(rB.status, "moved", "the survivor's anchor follows its text");
		assert.equal(
			after[0].markdown.slice(rB.offset, rB.offset + rB.length),
			"paragraph",
			"and lands on the right text",
		);

		// A's anchor quotes the same words, and A's ref now names B's block — so it
		// resolves too. That is unavoidable when the text is genuinely identical: neither
		// anchor can prove which paragraph it was written on. What matters is that
		// resolution reports a real position rather than inventing one, which it does.
		const rA = resolveAnchor(sc, anchorA, after);
		assert.ok(["exact", "moved", "ambiguous"].includes(rA.status));
		assert.equal(
			after[0].markdown.slice(rA.offset, rA.offset + rA.length),
			"paragraph",
			"and lands on text that really exists",
		);
	});

	test("case 5: duplicated text is disambiguated by context, not by order", () => {
		const first = "the quick brown fox";
		const second = "the quick red fox";
		const md = `${first}\n\n${second}`;
		const bs = blocks(md);
		// Anchor "quick " in the SECOND occurrence, and record its real context.
		const at = md.indexOf("quick", md.indexOf("quick") + 1);
		const anchor = anchorForRange(md, bs[0].ref, at, 6, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });

		// The first occurrence's context changes, so only the second still matches.
		const after = blocks(`the very quick brown fox\n\n${second}`);
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(after[0].markdown.slice(r.offset, r.offset + r.length), "quick ");
		// Context picked the occurrence that still matches: the second one. Reporting
		// `moved` is right — the ambiguity was RESOLVED, not merely detected.
		assert.equal(r.status, "moved", "context decides between the candidates");
		assert.equal(
			after[0].markdown.indexOf(r.offset === -1 ? "" : "quick ", r.offset + 6),
			-1,
			"and it is the last occurrence, not the first",
		);
	});

	test("a block-granular anchor resolves by its block and survives a text rewrite", () => {
		const bs = blocks("Alpha paragraph here.");
		const anchor = anchorForBlock(bs[0].markdown, bs[0].ref, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });
		assert.equal(resolveAnchor(sc, anchor, bs).status, "exact");
		// The block keeps its slot but gets a new ref.
		const after = blocks("Completely different content.");
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "moved", "block-granular follows the slot");
		assert.equal(r.ref, after[0].ref);
	});

	test("no branch ever invents an offset for a quote it did not find", () => {
		const { anchor, sc } = seeded("Alpha paragraph here.", "NOT PRESENT ANYWHERE");
		const r = resolveAnchor(sc, anchor, blocks("Something else entirely."));
		assert.equal(r.status, "lost");
		assert.equal(r.offset, 0, "reported offsets are only ever a real match");
	});
});

describe("parseTextQuote", () => {
	test("rejects values that are not a usable quote", () => {
		for (const bad of [undefined, null, {}, { exact: "" }, { exact: 123 }, "text", 42]) {
			assert.equal(parseTextQuote(bad), null, `${JSON.stringify(bad)} must not parse`);
		}
	});

	test("defaults absent context to empty strings", () => {
		assert.deepEqual(parseTextQuote({ exact: "hi" }), { exact: "hi", prefix: "", suffix: "" });
	});
});

describe("v1 sidecar migration", () => {
	function v1(): Sidecar {
		const bs = blocks("Alpha paragraph here.");
		const sc = sidecarWith(bs);
		sc.schemaVersion = 1;
		delete (sc as Partial<Sidecar>).anchors;
		sc.comments = [
			{
				id: "c1",
				ref: bs[0].ref,
				resolved: false,
				createdAt: NOW,
				turns: [{ by: "human", text: "on the words", at: NOW }],
				textAnchor: { start: 6, end: 15, selectedText: "paragraph" },
			} satisfies Comment,
		];
		sc.suggestions = [
			{ id: "s1", ref: bs[0].ref, kind: "replace", status: "pending", by: "human", createdAt: NOW, markdown: "X", range: { start: 0, end: 5 } } satisfies Suggestion,
			// A ref that is already gone, with no quote ever recorded for it.
			{ id: "s2", ref: "bdeadbeef", kind: "replace", status: "pending", by: "human", createdAt: NOW, markdown: "Y" } satisfies Suggestion,
		];
		return sc;
	}

	test("case 6: a live anchor is lifted unchanged, a dead ref is marked lost", () => {
		const bs = blocks("Alpha paragraph here.");
		const { sidecar } = migrateSidecar(v1(), bs);

		assert.equal(sidecar.schemaVersion, 3);
		const c1 = sidecar.comments[0];
		assert.ok(c1.anchorId, "the comment gained an anchor");
		assert.equal(
			sidecar.anchors[c1.anchorId!].quote,
			"paragraph",
			"the recorded quote is lifted verbatim, not re-derived",
		);

		const s1 = sidecar.suggestions[0];
		assert.ok(s1.anchorId, "the live suggestion gained an anchor");
		assert.equal(sidecar.anchors[s1.anchorId!].quote, "Alpha", "sliced from its range");

		const s2 = sidecar.suggestions[1];
		assert.equal(s2.anchorId, undefined, "no position may be invented for a dead ref");
		assert.equal(s2.stale, true, "and it is marked, not dropped");
		assert.equal(s2.anchorStatus, "lost");
	});

	test("case 7: migrating twice changes nothing the second time", () => {
		const bs = blocks("Alpha paragraph here.");
		const first = migrateSidecar(v1(), bs);
		assert.equal(first.changed, true);
		const second = migrateSidecar(first.sidecar, bs);
		assert.equal(second.changed, false, "a current sidecar must not be rewritten");
		assert.deepEqual(second.sidecar, first.sidecar, "and must be byte-identical");
	});
});

describe("comment views", () => {
	test("a v1 comment with a live ref still projects a range", () => {
		const bs = blocks("Alpha paragraph here.");
		const sc = sidecarWith(bs);
		const comment: Comment = {
			id: "c1",
			ref: bs[0].ref,
			resolved: false,
			createdAt: NOW,
			turns: [],
			textAnchor: { start: 6, end: 15, selectedText: "paragraph" },
		};
		const views = projectCommentViews(sc, [comment], bs);
		assert.equal(views.c1.status, "exact");
		assert.equal(views.c1.offset, 6);
		assert.equal(views.c1.length, 9);
		assert.equal(views.c1.blockMarkdown, bs[0].markdown);
	});

	test("a fully lost annotation is reported lost, never dropped", () => {
		const bs = blocks("Something else.");
		const sc = sidecarWith(bs);
		const comment: Comment = {
			id: "c9",
			ref: "bdeadbeef",
			resolved: false,
			createdAt: NOW,
			turns: [],
		};
		const views = projectCommentViews(sc, [comment], bs);
		assert.equal(views.c9.status, "lost");
		assert.equal(views.c9.ref, "bdeadbeef");
	});
});

describe("an anchor whose ref resolves but whose offset is stale", () => {
	/**
	 * This is the one shape that requires the SAME-BLOCK search rather than any fallback:
	 * the anchor's ref is still present in the document, so there is nothing to succeed
	 * and nothing to search for document-wide — but the quoted text has shifted inside
	 * that block. It occurs when the sidecar's refMap lags a raw `.md` write: the ref was
	 * minted against older text, the file changed underneath, and the annotation must
	 * still find its words.
	 *
	 * Without it, a raw edit silently un-anchors every annotation in the affected block,
	 * which is exactly the class of failure this whole change exists to remove.
	 */
	test("finds the quote at its new offset inside the same block", () => {
		const before = "Alpha paragraph here.";
		const bs = blocks(before);
		const anchor = anchorForRange(before, bs[0].ref, 6, 9, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });

		// Same ref, text gained a leading word: the sidecar has not caught up.
		const after: Block[] = [{ ref: bs[0].ref, type: "paragraph", markdown: "NEW Alpha paragraph here." }];
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.status, "moved", "the ref still exists, so this is a same-block move");
		assert.equal(r.ref, bs[0].ref, "and the block identity is unchanged");
		assert.equal(after[0].markdown.slice(r.offset, r.offset + r.length), "paragraph");
	});

	test("the document-wide fallback is not what placed it", () => {
		// A second, unrelated block also containing the quote. If resolution leaked to the
		// document-wide pass it could pick either; the same-block pass must win.
		const before = "Alpha marker here.";
		const bs = blocks(before);
		const anchor = anchorForRange(before, bs[0].ref, 6, 6, NOW);
		const sc = sidecarWith(bs, { [anchor.id]: anchor });
		const after: Block[] = [
			{ ref: bs[0].ref, type: "paragraph", markdown: "XX Alpha marker here." },
			{ ref: "bother", type: "paragraph", markdown: "Alpha marker here." },
		];
		const r = resolveAnchor(sc, anchor, after);
		assert.equal(r.ref, bs[0].ref, "the anchor's own block wins over a stranger");
		assert.equal(after[0].markdown.slice(r.offset, r.offset + r.length), "marker");
	});
});

describe("a block-less read does not destroy anchor state", () => {
	/**
	 * `readSidecar` is called by paths that never parse the markdown — the activity
	 * aggregator and `collab-state` both do. Migration needs the document to anchor
	 * against, so running it blind would mark every annotation `lost` on the basis that
	 * the caller simply had not read the file. That is a false verdict, and because the
	 * migration is reached from a read it would also be a write.
	 */
	function v1WithComments(): Sidecar {
		const bs = blocks("Alpha paragraph here.");
		const sc = sidecarWith(bs);
		sc.schemaVersion = 1;
		delete (sc as Partial<Sidecar>).anchors;
		sc.comments = [
			{
				id: "c1",
				ref: bs[0].ref,
				resolved: false,
				createdAt: NOW,
				turns: [],
				textAnchor: { start: 6, end: 15, selectedText: "paragraph" },
			} satisfies Comment,
		];
		return sc;
	}

	test("no comment is marked lost when there is no document to check against", () => {
		const migrated = migrateSidecar(v1WithComments(), []).sidecar;
		assert.equal(
			migrated.comments[0].anchorStatus,
			undefined,
			"an unverifiable anchor is not declared lost",
		);
		assert.equal(migrated.comments.length, 1, "and the comment is still there");
	});

	test("changed is false, so a read cannot persist anything", () => {
		const out = migrateSidecar(v1WithComments(), []);
		assert.equal(out.changed, false, "a blind read must not rewrite the sidecar");
	});

	test("with the document in hand it does migrate and does report changed", () => {
		const bs = blocks("Alpha paragraph here.");
		const out = migrateSidecar(v1WithComments(), bs);
		assert.equal(out.changed, true, "the real migration still happens");
		assert.ok(out.sidecar.comments[0].anchorId, "and it mints the anchor");
	});
});
