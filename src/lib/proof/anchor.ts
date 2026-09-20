/**
 * Durable anchors for annotations.
 *
 * Block refs are content-derived, so storing a ref as an annotation's identity makes
 * that identity a FUNCTION OF THE TEXT IT ANNOTATES: edit the text and the identity is
 * destroyed. An anchor is opaque instead — it records where the text was plus the text
 * itself — so editing the text under an anchor MOVES it rather than invalidating it.
 *
 * The quote fields follow the W3C Web Annotation Data Model's TextQuoteSelector
 * (`exact`/`prefix`/`suffix`). `prefix`/`suffix` exist for the ambiguous case, where the
 * same words appear twice and only surrounding context distinguishes them.
 */

import type { Anchor, AnchorStatus, Block, Comment, Sidecar } from "./types";

/** Context length captured either side of the quote, per the W3C selector's guidance. */
const CONTEXT_CHARS = 32;

/**
 * Where an anchor is NOW, and how confident that is. Block-local fields, so a `moved`
 * result is a one-field copy rather than a remap across every annotation.
 */
interface ResolvedAnchor {
	ref: string | null;
	offset: number;
	length: number;
	status: AnchorStatus;
}

export interface TextQuoteSelector {
	exact: string;
	prefix: string;
	suffix: string;
}

let anchorCounter = 0;

/**
 * Mint an opaque anchor id.
 *
 * Deliberately NOT content-derived — that is the entire point. A monotonic counter plus
 * a random suffix keeps ids unique within a sidecar without any dependence on the text
 * the anchor points at.
 */
function mintAnchorId(used: Set<string> = new Set()): string {
	for (;;) {
		anchorCounter = (anchorCounter + 1) % 0xffffff;
		const id = `a${anchorCounter.toString(16).padStart(6, "0")}`;
		if (!used.has(id)) return id;
	}
}

/**
 * Read a quote selector out of an unvalidated sidecar value.
 *
 * A v1 sidecar is data on disk that this code did not write, so every field is
 * untrusted. Returning `null` rather than a half-built object keeps a malformed record
 * from reaching the resolver as `exact: undefined`, where `indexOf(undefined)` would
 * quietly become the string "undefined" and match nothing — a failure that looks like
 * data loss instead of a schema error.
 */
export function parseTextQuote(value: unknown): TextQuoteSelector | null {
	if (typeof value !== "object" || value === null) return null;
	const v = value as Record<string, unknown>;
	if (typeof v.exact !== "string" || v.exact.length === 0) return null;
	return {
		exact: v.exact,
		prefix: typeof v.prefix === "string" ? v.prefix : "",
		suffix: typeof v.suffix === "string" ? v.suffix : "",
	};
}

/** The `prefix`/`suffix` around a block-local range, for disambiguation later. */
function quoteContext(
	markdown: string,
	offset: number,
	length: number,
): { prefix: string; suffix: string } {
	return {
		prefix: markdown.slice(Math.max(0, offset - CONTEXT_CHARS), offset),
		suffix: markdown.slice(offset + length, offset + length + CONTEXT_CHARS),
	};
}

/** Build an anchor for a range the caller has just validated against `markdown`. */
export function anchorForRange(
	markdown: string,
	ref: string,
	offset: number,
	length: number,
	now: string,
	used?: Set<string>,
): Anchor {
	const { prefix, suffix } = quoteContext(markdown, offset, length);
	return {
		id: mintAnchorId(used),
		ref,
		offset,
		length,
		quote: markdown.slice(offset, offset + length),
		prefix,
		suffix,
		createdAt: now,
		updatedAt: now,
	};
}

/** Build an anchor that covers a whole block (no selection). */
export function anchorForBlock(markdown: string, ref: string, now: string, used?: Set<string>): Anchor {
	return {
		id: mintAnchorId(used),
		ref,
		offset: 0,
		length: 0,
		quote: markdown,
		prefix: "",
		suffix: "",
		createdAt: now,
		updatedAt: now,
	};
}

/** Every index at which `needle` occurs in `haystack`. Empty needle never matches. */
function allIndices(haystack: string, needle: string): number[] {
	if (!needle) return [];
	const hits: number[] = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		hits.push(at);
		at = haystack.indexOf(needle, at + 1);
	}
	return hits;
}

/**
 * How well a candidate position reproduces the anchor's recorded context.
 *
 * Higher is better; the scores are comparable only with each other. This is what makes
 * the ambiguous case decidable: when `quote` appears twice, the occurrence whose
 * neighbours match what was recorded is the one the annotation belongs to.
 */
function contextScore(markdown: string, at: number, length: number, anchor: Anchor): number {
	let score = 0;
	if (anchor.prefix) {
		const before = markdown.slice(Math.max(0, at - anchor.prefix.length), at);
		// Longest common suffix, since the prefix sits immediately before the quote.
		let i = 0;
		while (i < before.length && i < anchor.prefix.length && before[before.length - 1 - i] === anchor.prefix[anchor.prefix.length - 1 - i]) {
			i += 1;
		}
		score += i;
	}
	if (anchor.suffix) {
		const after = markdown.slice(at + length, at + length + anchor.suffix.length);
		let i = 0;
		while (i < after.length && i < anchor.suffix.length && after[i] === anchor.suffix[i]) {
			i += 1;
		}
		score += i;
	}
	return score;
}

/** Pick the occurrence nearest `target`, breaking ties by context match. */
function bestHit(
	markdown: string,
	hits: number[],
	target: number,
	length: number,
	anchor: Anchor,
): { at: number; ambiguous: boolean } {
	if (hits.length === 1) return { at: hits[0], ambiguous: false };

	let best = hits[0];
	let bestDistance = Math.abs(best - target);
	for (const hit of hits) {
		const distance = Math.abs(hit - target);
		if (distance < bestDistance) {
			best = hit;
			bestDistance = distance;
		}
	}

	// Two or more occurrences are equally close — or the nearest one's context does not
	// match what was recorded while another's does. Only the recorded context can
	// separate them, so it decides; a genuine tie is reported as ambiguous rather than
	// silently resolved to whichever came first in the document.
	const equallyNear = hits.filter((h) => Math.abs(h - target) === bestDistance);
	if (equallyNear.length === 1) {
		const scored = hits
			.map((h) => ({ h, s: contextScore(markdown, h, length, anchor) }))
			.sort((a, b) => b.s - a.s);
		if (scored.length > 1 && scored[0].s > scored[1].s) return { at: scored[0].h, ambiguous: false };
		return { at: best, ambiguous: false };
	}

	const scored = equallyNear
		.map((h) => ({ h, s: contextScore(markdown, h, length, anchor) }))
		.sort((a, b) => b.s - a.s);
	const tied = scored.filter((c) => c.s === scored[0].s);
	if (tied.length > 1) return { at: tied[0].h, ambiguous: true };
	return { at: scored[0].h, ambiguous: true };
}

/**
 * Find where an anchor's text now lives.
 *
 * Order is the whole design, and it is deliberately cheapest-and-most-certain first:
 *
 *   1. `exact`    — still where it was. No search needed, and this is the common case
 *                   for every annotation in an untouched document.
 *   2. `moved`    — the text is still in the same block, at a different offset. This is
 *                   what a user typing inside the annotated sentence produces, and it
 *                   is precisely the case the old content-hash identity could not
 *                   survive.
 *   3. `moved`    — the block is gone but a block now occupies its old slot, and the
 *                   text is in it. This is what the positional aliasing in 6f9fd72
 *                   approximated, and it is now a search for recorded text rather than
 *                   a guess at a thrown-away identity.
 *   4. `ambiguous`/`lost` — see above and below.
 *
 * A `length` of 0 means block-granular: the anchor covers its block, so it resolves
 * against the block's existence and needs no text search at all.
 */
export function resolveAnchor(
	sidecar: Sidecar,
	anchor: Anchor,
	blocks: Block[],
): ResolvedAnchor {
	const byRef = new Map(blocks.map((b) => [b.ref, b]));
	const own = byRef.get(anchor.ref);

	// Block-granular: the anchor is the block, so its identity is the block's.
	if (anchor.length === 0) {
		if (own) return { ref: own.ref, offset: 0, length: 0, status: "exact" };
		const successor = successorFor(sidecar, anchor.ref, blocks);
		if (successor) return { ref: successor.ref, offset: 0, length: 0, status: "moved" };
		return { ref: null, offset: 0, length: 0, status: "lost" };
	}

	// 1. Still where it was.
	if (own) {
		const here = own.markdown.slice(anchor.offset, anchor.offset + anchor.length);
		if (here === anchor.quote) {
			return { ref: own.ref, offset: anchor.offset, length: anchor.length, status: "exact" };
		}

		// 2. Same block, new offset — the user typed inside the sentence.
		const hits = allIndices(own.markdown, anchor.quote);
		if (hits.length > 0) {
			const { at, ambiguous } = bestHit(own.markdown, hits, anchor.offset, anchor.length, anchor);
			return {
				ref: own.ref,
				offset: at,
				length: anchor.length,
				status: ambiguous ? "ambiguous" : "moved",
			};
		}

		// 2b. The block is still here under its own ref, but the quoted span is not
		//    verbatim inside it. Report the BLOCK; keep the span uncertain.
		//
		//    `lost` here was destructive, not merely pessimistic. Accepting a ranged
		//    suggestion resolves the anchor only to find the block, then three-way
		//    merges `baseMarkdown` against the block's current text — which is exactly
		//    the case where an edit ELSEWHERE in the block leaves the quoted span
		//    untouched but stops it matching. Reporting `lost` returned -1, so the
		//    merge was skipped and the concurrent edit was overwritten.
		//
		//    offset/length stay 0: no position was found and the spec forbids
		//    inventing one. Callers wanting a span treat `ambiguous` as "re-search
		//    within the block", which is what the highlight does.
		return { ref: own.ref, offset: 0, length: 0, status: "ambiguous" };
	}

	// 3. The block is gone; look in whatever took its slot.
	const successor = successorFor(sidecar, anchor.ref, blocks);
	if (successor) {
		const hits = allIndices(successor.markdown, anchor.quote);
		if (hits.length > 0) {
			const { at, ambiguous } = bestHit(successor.markdown, hits, anchor.offset, anchor.length, anchor);
			return {
				ref: successor.ref,
				offset: at,
				length: anchor.length,
				status: ambiguous ? "ambiguous" : "moved",
			};
		}

		// 3b. Same situation as 2b, one generation on: the block was rehashed by an
		//     edit, so it now lives under a NEW ref and the quote no longer matches.
		//     See 2b for why `lost` here loses the concurrent edit.
		//
		//     Gated on `prevRefOrder` being present, and that gate is load-bearing.
		//     Without it `successorFor` falls back to the CURRENT refMap key order,
		//     which after a delete-and-replace names whatever now sits at that index —
		//     a stranger. Attaching an annotation to unrelated text is worse than
		//     losing it, so the slot is followed only when a reparse recorded a
		//     previous ordering; otherwise this stays `lost`.
		//     (anchor-resolution.test.ts case 3c pins that.)
		if (sidecar.prevRefOrder) {
			return { ref: successor.ref, offset: 0, length: 0, status: "ambiguous" };
		}
	}

	// 4. Last resort: the block is gone and its slot holds something unrelated, but the
	//    recorded text may still exist elsewhere — a block moved, or a duplicate was
	//    deleted and its identical twin reclaimed the shared ref.
	//
	//    This is the case `survivesViaAlias` was written to paper over: two identical
	//    paragraphs swap refs when the first is deleted, so a comment on the survivor
	//    looked orphaned even though its text was still on screen. Content decides here,
	//    which is what the anchor was for.
	//
	//    Only a UNIQUE match is accepted. If the text occurs more than once the anchor
	//    cannot say which one it meant, and picking one would annotate a stranger.
	let match: { block: Block; at: number } | null = null;
	let count = 0;
	for (const block of blocks) {
		const hits = allIndices(block.markdown, anchor.quote);
		for (const at of hits) {
			count += 1;
			if (count === 1) match = { block, at };
		}
	}
	if (count === 1 && match) {
		return { ref: match.block.ref, offset: match.at, length: anchor.length, status: "moved" };
	}
	if (count > 1) {
		// Present, but not uniquely attributable. Reported rather than guessed at.
		return { ref: null, offset: 0, length: 0, status: "ambiguous" };
	}

	// 5. Nothing recorded still matches. Say so rather than pick a position: a wrong
	//    range is worse than a visible loss, because it silently annotates other text.
	return { ref: null, offset: 0, length: 0, status: "lost" };
}

/**
 * The block now occupying the dead ref's old slot, if any.
 *
 * `refMap`'s keys are inserted in document order by `assignRefs`, so the key order is the
 * previous block ordering — the same fact the positional-aliasing pass in 6f9fd72 relied
 * on. Returns null when the old ref was never known or its slot no longer exists, so a
 * caller cannot mistake "unknown" for "successor".
 */
function successorFor(sidecar: Sidecar, ref: string, blocks: Block[]): Block | null {
	// Prefer the pre-reparse ordering: `refMap` has already been replaced with the NEW
	// refs by the time a snapshot is built, so the anchor's own ref — which belongs to
	// the previous ordering — would not be found in it at all.
	const order =
		sidecar.prevRefOrder && sidecar.prevRefOrder.includes(ref)
			? sidecar.prevRefOrder
			: Object.keys(sidecar.refMap);
	const at = order.indexOf(ref);
	if (at === -1 || at >= blocks.length) return null;
	const candidate = blocks[at];
	// A block still named by a ref different from the dead one is a genuine occupant of
	// the slot. If the dead ref is somehow still present, this is not a successor case.
	return candidate && candidate.ref !== ref ? candidate : null;
}

/**
 * A comment plus its resolved position, for surfaces that render outside the sidecar.
 *
 * The editor reads `snapshotBlocks` and `sidecar.suggestions` from two independent store
 * paths fed by two separate HTTP calls, and `Snapshot` carries no anchor records. A
 * client-side resolver would therefore have nothing to resolve against, so resolution is
 * produced server-side per read and shipped in the snapshot.
 */
export interface CommentView {
	id: string;
	anchorId?: string;
	ref: string | null;
	offset: number;
	length: number;
	status: AnchorStatus;
	/** Block markdown the resolved offset is relative to, so the client can paint. */
	blockMarkdown?: string;
}

/** Resolve every comment against the blocks read in the same request. */
export function projectCommentViews(
	sidecar: Sidecar,
	comments: Comment[],
	blocks: Block[],
): Record<string, CommentView> {
	const byRef = new Map(blocks.map((b) => [b.ref, b]));
	const views: Record<string, CommentView> = {};
	for (const comment of comments) {
		views[comment.id] = viewFor(sidecar, comment, blocks, byRef);
	}
	return views;
}

function viewFor(
	sidecar: Sidecar,
	comment: Comment,
	blocks: Block[],
	byRef: Map<string, Block>,
): CommentView {
	const anchor = comment.anchorId ? sidecar.anchors[comment.anchorId] : undefined;
	if (!anchor) {
		// A v1 comment, or one whose anchor could not be reconstructed. `ref` is the
		// legacy fallback and is still honoured here so old data keeps rendering.
		const legacyRef = comment.ref ?? null;
		const block = legacyRef ? byRef.get(legacyRef) : undefined;
		return {
			id: comment.id,
			ref: legacyRef,
			offset: comment.textAnchor?.start ?? 0,
			length: comment.textAnchor ? comment.textAnchor.end - comment.textAnchor.start : 0,
			status: legacyRef ? (block ? "exact" : "lost") : "lost",
			...(block ? { blockMarkdown: block.markdown } : {}),
		};
	}
	const resolved = resolveAnchor(sidecar, anchor, blocks);
	const block = resolved.ref ? byRef.get(resolved.ref) : undefined;
	return {
		id: comment.id,
		anchorId: anchor.id,
		ref: resolved.ref,
		offset: resolved.offset,
		length: resolved.length,
		status: resolved.status,
		...(block ? { blockMarkdown: block.markdown } : {}),
	};
}

export type { Anchor, AnchorStatus, Comment, Sidecar };
/**
 * Upgrade a stored sidecar to the current schema.
 *
 * Pure and idempotent: it returns `changed: false` immediately for a current sidecar, so
 * a read that changed nothing cannot write anything. That property matters because a
 * plain GET must never rewrite a file — a lesson already paid for once in this codebase,
 * where an unconditional write per operation made the file watcher fire on every
 * keystroke and reload the document out from under the user.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * A v1 suggestion carries only a content-derived `ref` and a numeric `range`. If that
 * ref is already gone, no quote was ever recorded for it — there is nothing to search
 * for and no honest position to reconstruct. Such a record is marked `lost` and left
 * without an anchor. Inventing a position would silently attach the annotation to
 * whatever text now sits there, which is worse than telling the user it was lost.
 */
export function migrateSidecar(
	sidecar: Sidecar,
	blocks: Block[],
): { sidecar: Sidecar; changed: boolean } {
	if (sidecar.schemaVersion >= 3) return { sidecar, changed: false };

	// Without the document there is nothing to anchor TO, and marking annotations lost on
	// that basis would be a false verdict: the caller simply has not read the file. That
	// is a real call pattern — the activity aggregator and `collab-state` read sidecars
	// without parsing the markdown — so a block-less read reports "not migrated" rather
	// than destroying anchor state. `changed: false` keeps the read from persisting it.
	if (blocks.length === 0 && sidecar.comments.length > 0) {
		// Return the sidecar UNCHANGED — deliberately not stamped version 3.
		//
		// `readSidecar` discards the `changed` flag and hands this object to callers
		// that write snapshots back. Stamping 3 here would persist "migrated, nothing
		// to migrate", and every later migration would exit at the `schemaVersion >= 3`
		// guard above. The annotations would stay legacy forever — the exact
		// durable-anchor loss this module exists to prevent. Leaving the version alone
		// means the next read WITH blocks migrates properly.
		return { sidecar: { ...sidecar, anchors: sidecar.anchors ?? {} }, changed: false };
	}

	const now = sidecar.updatedAt || new Date().toISOString();
	const anchors: Record<string, Anchor> = { ...(sidecar.anchors ?? {}) };
	const used = new Set(Object.keys(anchors));
	const byRef = new Map(blocks.map((b) => [b.ref, b]));

	// A ref that resolves through a one-generation alias is still alive. Consulted here
	// because this is the last read of `refAliases` before the field is dropped.
	const liveRef = (ref: string): Block | undefined =>
		byRef.get(ref) ?? byRef.get(sidecar.refAliases?.[ref] ?? "");

	let changed = false;

	const comments = sidecar.comments.map((c) => {
		if (c.anchorId && anchors[c.anchorId]) return c;
		changed = true;

		// The quote was already recorded at write time; lift it unchanged.
		if (c.textAnchor) {
			const block = liveRef(c.ref ?? "");
			const anchor: Anchor = {
				id: mintAnchorId(used),
				ref: block?.ref ?? c.ref ?? "",
				offset: c.textAnchor.start,
				length: c.textAnchor.end - c.textAnchor.start,
				quote: c.textAnchor.selectedText,
				prefix: "",
				suffix: "",
				createdAt: c.createdAt || now,
				updatedAt: now,
			};
			if (block) {
				const ctx = quoteContext(block.markdown, anchor.offset, anchor.length);
				anchor.prefix = ctx.prefix;
				anchor.suffix = ctx.suffix;
			}
			anchors[anchor.id] = anchor;
			return { ...c, anchorId: anchor.id };
		}

		// No selection: the comment covers its whole block.
		const block = liveRef(c.ref ?? "");
		if (!block) return { ...c, anchorStatus: "lost" as const };
		const anchor = anchorForBlock(block.markdown, block.ref, now, used);
		anchors[anchor.id] = anchor;
		return { ...c, anchorId: anchor.id };
	});

	return {
		sidecar: {
			...sidecar,
			schemaVersion: 3,
			anchors,
			comments,
			updatedAt: now,
		},
		changed,
	};
}
