/**
 * Orphaned-annotation reporting and recovery (DoD #6, Phase 6).
 *
 * THE BUG THIS FIXES
 * ------------------
 * `markOrphanedRefsStale` (ops-applier.ts:119) sets `stale = true` when a ref
 * disappears after an external edit. But:
 *   - the only two un-stale sites are reachable ONLY via `lineAnchor`, so a
 *     block-ref comment could never come back;
 *   - nothing in the UI, the API or the snapshot surfaced the flag;
 *   - both render paths (`suggestion-decorator.ts:85`, `editor.tsx:235`) SKIP
 *     stale entries.
 *
 * Net effect: an external edit made annotations vanish with no signal and no
 * recovery. Confirmed empirically in repro-stale-latch.test.ts.
 *
 * WHAT THIS MODULE DOES
 * ---------------------
 * Turns `stale` from a silent tombstone into a first-class reported state with
 * an explicit recovery action. Recovery works because the anchor now carries
 * `selectedText` (Phase 2): we can SEARCH for the text in the current document
 * and re-mint the anchor. A hash could verify but never find — that was the
 * whole reason the latch was one-way.
 */

import type { Comment, Suggestion, Block, TextRangeAnchor } from "./types";
import { locateCommentAnchor } from "./comment-decorator";

export interface OrphanedAnnotation {
	id: string;
	kind: "comment" | "suggestion";
	/** Human-readable explanation for the UI. */
	reason: string;
	/** The text that was originally anchored, when known. */
	selectedText?: string;
	/** Block it was anchored to. */
	ref?: string;
	/** Whether a re-anchor is possible at all. */
	recoverable: boolean;
	createdAt: string;
}

export interface OrphanReport {
	orphaned: OrphanedAnnotation[];
	/** Refs referenced by orphaned annotations that no longer exist. */
	missingRefs: string[];
}

/**
 * Collect every orphaned annotation into a reportable, renderable list.
 *
 * This is the "surfaced" half of DoD #6: the previous state was discoverable
 * only by reading raw sidecar records.
 */
export function reportOrphans(
	comments: readonly Comment[],
	suggestions: readonly Suggestion[],
): OrphanReport {
	const orphaned: OrphanedAnnotation[] = [];
	const missingRefs = new Set<string>();

	for (const comment of comments) {
		if (!comment.stale || comment.resolved) continue;
		orphaned.push({
			id: comment.id,
			kind: "comment",
			reason: comment.textAnchor
				? "The text this comment was anchored to changed or moved."
				: "The block this comment was anchored to no longer exists.",
			...(comment.textAnchor ? { selectedText: comment.textAnchor.selectedText } : {}),
			...(comment.ref ? { ref: comment.ref } : {}),
			// Recovery needs the text to search for. A legacy block-only
			// comment has nothing to search with — reported honestly.
			recoverable: !!comment.textAnchor?.selectedText,
			createdAt: comment.createdAt,
		});
		if (comment.ref) missingRefs.add(comment.ref);
	}

	for (const suggestion of suggestions) {
		if (!suggestion.stale || suggestion.status !== "pending") continue;
		orphaned.push({
			id: suggestion.id,
			kind: "suggestion",
			reason: "The block this suggestion applied to no longer exists.",
			...(suggestion.baseMarkdown ? { selectedText: suggestion.baseMarkdown } : {}),
			ref: suggestion.ref,
			// A suggestion is block-granular with no text anchor to search for,
			// so it cannot be auto-recovered — only shown and dismissed.
			recoverable: false,
			createdAt: suggestion.createdAt,
		});
		missingRefs.add(suggestion.ref);
	}

	return { orphaned, missingRefs: [...missingRefs] };
}

export interface ReanchorResult {
	/** The re-minted anchor, when recovery succeeded. */
	anchor?: TextRangeAnchor;
	/** The block the text was found in. */
	ref?: string;
	status: "recovered" | "not-found" | "not-recoverable";
}

/**
 * Try to re-anchor a stale comment against the current document.
 *
 * Searches every current block for the stored text. Returns a fresh anchor with
 * offsets valid for the block's CURRENT markdown, plus the block ref it landed
 * in — which may differ from the original, since the text may have moved into a
 * different block after an external edit.
 */
export function reanchorComment(
	comment: Comment,
	blocks: readonly Block[],
): ReanchorResult {
	const anchor = comment.textAnchor;
	if (!anchor?.selectedText) return { status: "not-recoverable" };

	const needle = anchor.selectedText;

	for (const block of blocks) {
		// Search the block's markdown for the anchored text.
		const at = block.markdown.indexOf(needle);
		if (at === -1) continue;
		return {
			status: "recovered",
			ref: block.ref,
			anchor: {
				start: at,
				end: at + needle.length,
				selectedText: needle,
				baseMarkdown: block.markdown,
			},
		};
	}

	return { status: "not-found" };
}

/**
 * Recover as many orphaned comments as possible in one pass.
 *
 * Pure: returns the anchors to apply, leaving the caller to persist them through
 * the normal op path (so recovery is audited like any other mutation).
 */
export function planRecovery(
	comments: readonly Comment[],
	blocks: readonly Block[],
): Array<{ commentId: string; anchor: TextRangeAnchor; ref: string }> {
	const plan: Array<{ commentId: string; anchor: TextRangeAnchor; ref: string }> = [];
	for (const comment of comments) {
		if (!comment.stale || comment.resolved) continue;
		const result = reanchorComment(comment, blocks);
		if (result.status === "recovered" && result.anchor && result.ref) {
			plan.push({ commentId: comment.id, anchor: result.anchor, ref: result.ref });
		}
	}
	return plan;
}

/** Whether a comment's stored anchor still resolves against current blocks. */
export function anchorStillValid(
	comment: Comment,
	blocks: readonly Block[],
): boolean {
	if (!comment.textAnchor) return !comment.stale;
	const block = blocks.find((b) => b.ref === comment.ref);
	if (!block) return false;
	return locateCommentAnchor(comment.textAnchor, block.markdown).status !== "orphaned";
}