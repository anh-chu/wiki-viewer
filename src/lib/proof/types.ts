export type BlockType =
	| "heading"
	| "paragraph"
	| "bulletList"
	| "orderedList"
	| "taskList"
	| "blockquote"
	| "codeBlock"
	| "table"
	| "hr"
	| "html";

export interface Block {
	ref: string; // "b" + 6-hex
	type: BlockType;
	level?: number; // headings only
	lang?: string; // codeBlock only
	markdown: string; // canonical markdown for this block, trailing \n stripped
}

export interface ProvenanceMeta {
	origin: "human" | "ai";
	basis?: "described" | "inferred" | "suggested";
	basisDetail?: string;
	by?: string; // "ai:claude" or "human"
	at?: string; // ISO 8601
	spanId: string; // "p" + 4-hex
	inResponseTo?: string; // comment id
}

export interface CommentTurn {
	by: string; // "human" | "ai:claude"
	text: string;
	at: string;
}

export interface LineAnchor {
	lineStart: number; // 1-based
	lineEnd: number;
	textHash: string; // sha256 first 12 hex of anchored lines
}

/**
 * A block-anchored annotation is either a human `comment` or an agent
 * `instruction` (a work order queued for a batch "Send to agent" run). Absent
 * `kind` means legacy `comment`.
 */
export type AnnotationKind = "comment" | "instruction";

/** Lifecycle of an instruction annotation before/after a batch send. */
export type InstructionState = "draft" | "queued" | "sent" | "answered";

/**
 * An exact text range inside a block, plus the text itself.
 *
 * Offsets alone cannot carry an anchor: `ref` is block-granular ("this paragraph",
 * not "these words"), and offsets shift under every nearby edit. Storing `selectedText`
 * makes the anchor SEARCHABLE, which is what makes an orphaned anchor recoverable at
 * all — a hash can verify an anchor and never find one. Text is the difference between
 * "was here" and "is here".
 */
export interface TextRangeAnchor {
	/** Offsets within the block's markdown at the time of anchoring. */
	start: number;
	end: number;
	/** The exact text the user selected. Makes the anchor recoverable. */
	selectedText: string;
	/** Snapshot of the block markdown the offsets were computed against. */
	baseMarkdown?: string;
}

/**
 * A durable, opaque pointer to a place in the document.
 *
 * `id` is deliberately not derived from content — that is the point. The quote fields
 * follow the W3C TextQuoteSelector so the anchor can be re-found after an edit.
 */
export interface Anchor {
	id: string;
	/** Last known block ref. A hint for resolution, not the identity. */
	ref: string;
	/** Block-local character offset of the quoted text. */
	offset: number;
	/** Quoted length; 0 means the anchor covers its whole block. */
	length: number;
	/** The exact text at creation. This is what makes the anchor findable again. */
	quote: string;
	/** Up to 32 chars before the quote, for disambiguating repeated text. */
	prefix: string;
	/** Up to 32 chars after the quote, likewise. */
	suffix: string;
	createdAt: string;
	updatedAt: string;
}

/**
 * How confidently an anchor was placed.
 *
 * - `exact`     — still where it was recorded.
 * - `moved`     — found again elsewhere; the offset here is the NEW one.
 * - `ambiguous` — found more than once and context could not fully separate them.
 * - `lost`      — the recorded text is gone. Surfaced, never silently dropped.
 */
export type AnchorStatus = "exact" | "moved" | "ambiguous" | "lost";

export interface Comment {
	id: string; // "c" + 4-hex
	/** The durable anchor this comment hangs off. Absent on v1 records. */
	anchorId?: string;
	/** Resolved position, filled by the server read. Never persisted. */
	anchorStatus?: AnchorStatus;
	ref?: string; // LEGACY v1: block ref. Read-only fallback.

	lineAnchor?: LineAnchor;
	/** Exact commented text. Absent => block-granular (legacy comment). */
	textAnchor?: TextRangeAnchor;
	resolved: boolean;
	createdAt: string;
	turns: CommentTurn[];
	/** Set true when a raw .md overwrite orphans the anchor ref (R2 collab-anchor safety). */
	stale?: boolean;
	/**
	 * When the comment was auto-cancelled because its anchored text no longer
	 * exists in the document. A cancelled comment is also `resolved`, so it leaves
	 * the margin column and stops feeding agent prompts — the point of cancelling.
	 */
	cancelledAt?: string;
	/** Why it was cancelled. Currently only "anchor-lost". */
	cancelReason?: "anchor-lost";
	/** Annotation kind. Absent => "comment" (legacy). "instruction" = agent work order. */
	kind?: AnnotationKind;
	/** Instruction lifecycle. Only meaningful when kind === "instruction". */
	instructionState?: InstructionState;
	/** The batch send run this instruction went out in (correlates results). */
	runId?: string;
	/** Backlink to the comment this instruction was escalated from, if any. */
	fromCommentId?: string;
}

/**
 * What a suggestion proposes.
 *
 * `replace`/`insertAfter`/`insertBefore`/`delete` address a whole block and are what
 * the Suggest button produces. `insert`/`remove` describe a run of typed characters
 * inside a block, which is what Suggesting mode records; they carry `markdown` plus
 * the `range` the text belongs at, and `insert`/`remove` need that range to be placed.
 *
 * The distinction matters at accept time. A typed insertion is not a whole-block
 * replacement, and treating it as one replaces the block — so the kinds are named
 * separately here rather than folded into `insertAfter`.
 */
export type SuggestionKind =
	| "replace"
	| "insertAfter"
	| "insertBefore"
	/** A run of typed characters inserted inside a block, at `range`. */
	| "insert"
	/** A run of deleted characters, at `range`. */
	| "remove"
	| "delete";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface SuggestionRange {
	start: number;
	end: number;
}

export interface Suggestion {
	id: string; // "s" + 4-hex
	ref: string; // LEGACY v1: block ref. Read-only fallback.
	/** The durable anchor this suggestion hangs off. Absent on v1 records. */
	anchorId?: string;
	/** Resolved position, filled by the server read. Never persisted. */
	anchorStatus?: AnchorStatus;
	kind: SuggestionKind;
	status: SuggestionStatus;
	by: string;
	markdown?: string; // omitted for kind=delete
	range?: SuggestionRange;
	/** Snapshot block markdown used as the 3-way merge base for ranged suggestions. */
	baseMarkdown?: string;
	basis?: ProvenanceMeta["basis"];
	basisDetail?: string;
	createdAt: string;
	resolvedAt?: string; // when accepted/rejected
	resolvedBy?: string;
	/** Set true when a raw .md overwrite orphans the anchor ref (R2 collab-anchor safety). */
	stale?: boolean;
}

export interface ProofEvent {
	id: number;
	/**
	 * Known event types:
	 *   block.replaced | block.inserted | block.deleted
	 *   comment.added | comment.replied | comment.edited | comment.deleted | comment.resolved | comment.reopened
	 *   suggestion.added | suggestion.edited | suggestion.deleted | suggestion.accepted | suggestion.rejected
	 *   file.externallyEdited  — writer unknown (chokidar / external tool)
	 *   file.rawWritten        — writer known (by: "ai:<id>"), emitted by Tier-1 raw-fs write
	 */
	type: string;
	at: string;
	by: string;
	/**
	 * The sidecar revision this event left behind, when the producer knows it.
	 *
	 * A write response carries one, and applying that event must move the store's
	 * `snapshotRevision` to it: that value is the `baseRevision` the next request sends,
	 * so a client that does not adopt its own write's revision sends a base the server
	 * has already passed and every subsequent op is rejected `409 STALE_REVISION`. This
	 * field was read on the apply path but never populated by any producer, so the
	 * update looked handled and silently was not.
	 */
	revision?: number;
	[k: string]: unknown;
}

export interface Sidecar {
	schemaVersion: 1 | 2 | 3;
	path: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	// Map of block.ref -> current text fingerprint (sha256 of block markdown, first 12 hex).
	refMap: Record<string, { textHash: string; lastSeenAt: string }>;
	// History of ref renames. Old ref -> new ref, kept for ONE generation.
	// LEGACY (schema <= 2). Superseded by `anchors`; still read so a v1 sidecar can
	// resolve a ref that was renamed before the upgrade.
	refAliases: Record<string, string>;
	/**
	 * The block ordering as it stood BEFORE the most recent reparse (schema >= 2).
	 *
	 * Anchors record the ref they were last seen under. That ref is usually gone by the
	 * time a snapshot is built — the reparse replaces `refMap` with the new refs first —
	 * so the previous ordering has to be carried forward for a successor lookup to have
	 * anything to search. Without it a block-granular anchor on a rewritten block could
	 * not find the block that took its slot.
	 */
	prevRefOrder?: string[];
	/**
	 * Durable anchors, keyed by anchor id (schema >= 2).
	 *
	 * An annotation's identity now lives here rather than in its `ref`, so editing the
	 * text under an annotation moves its anchor instead of destroying it.
	 */
	anchors: Record<string, Anchor>;
	comments: Comment[];
	suggestions: Suggestion[];
	archivedSuggestions: Suggestion[];
	events: ProofEvent[];
	nextEventId: number;
	lastAck: Record<string, number>; // by -> eventId
	fingerprint: string; // last-known sha256 of the .md file
}

export type Op =
	| {
			type: "block.replace";
			ref: string;
			markdown: string;
			basis?: string;
			basisDetail?: string;
			inResponseTo?: string;
	  }
	| {
			type: "block.insertAfter";
			ref: string;
			markdown: string;
			basis?: string;
			basisDetail?: string;
			inResponseTo?: string;
	  }
	| {
			type: "block.insertBefore";
			ref: string;
			markdown: string;
			basis?: string;
			basisDetail?: string;
			inResponseTo?: string;
	  }
	| { type: "block.delete"; ref: string }
	| {
			type: "block.append";
			markdown: string;
			basis?: string;
			basisDetail?: string;
			inResponseTo?: string;
	  }
	| {
			type: "block.prepend";
			markdown: string;
			basis?: string;
			basisDetail?: string;
			inResponseTo?: string;
	  }
	| {
			type: "comment.add";
			ref?: string;
			lineAnchor?: LineAnchor;
			textAnchor?: TextRangeAnchor;
			text: string;
			/** Absent => "comment" (legacy). "instruction" creates a draft work order. */
			kind?: AnnotationKind;
			/** Backlink when escalated from an existing comment. */
			fromCommentId?: string;
	  }
	| { type: "comment.reply"; commentId: string; text: string }
	| { type: "comment.edit"; commentId: string; text: string }
	| { type: "comment.delete"; commentId: string }
	| {
			type: "comment.mark";
			commentId: string;
			instructionState: InstructionState;
			runId?: string;
	  }
	| { type: "comment.resolve"; commentId: string }
	| { type: "comment.reopen"; commentId: string }
	/**
	 * Re-anchor a stale comment after its block was orphaned (DoD #6, Phase 6).
	 *
	 * This is the RESET SITE for `stale`. Before this op existed, the only
	 * un-stale paths were reachable via `lineAnchor`, so a block-ref comment
	 * could never recover — the latch was one-way and the annotation was lost.
	 */
	| {
			type: "comment.reanchor";
			commentId: string;
			ref: string;
			textAnchor: TextRangeAnchor;
	  }
	| {
			type: "suggestion.add";
			ref: string;
			kind: SuggestionKind;
			markdown?: string;
			range?: SuggestionRange;
			baseMarkdown?: string;
			basis?: string;
			basisDetail?: string;
			status?: SuggestionStatus;
	  }
	| { type: "suggestion.accept"; suggestionId: string }
	| { type: "suggestion.reject"; suggestionId: string }
	| {
			type: "suggestion.edit";
			suggestionId: string;
			kind?: SuggestionKind;
			markdown?: string;
			range?: SuggestionRange;
	  }
	| { type: "suggestion.delete"; suggestionId: string };

export interface Snapshot {
	path: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	fingerprint: string;
	blocks: Block[];
	/**
	 * Every comment resolved against `blocks` in this same read.
	 *
	 * Shipped because the editor's blocks and its sidecar arrive from two independent
	 * requests, so a client-side resolver would have nothing to resolve against.
	 */
	commentViews?: Record<string, import("./anchor").CommentView>;
	comments: Comment[]; // unresolved + resolved (separately by client)
	suggestions: Suggestion[]; // pending only by default
	lastEventId: number;
}
