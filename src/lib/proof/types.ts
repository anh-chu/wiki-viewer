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

export interface Comment {
	id: string; // "c" + 4-hex
	ref?: string; // block ref it's attached to (markdown only)
	lineAnchor?: LineAnchor;
	resolved: boolean;
	createdAt: string;
	turns: CommentTurn[];
	/** Set true when a raw .md overwrite orphans the anchor ref (R2 collab-anchor safety). */
	stale?: boolean;
}

export type SuggestionKind =
	| "replace"
	| "insertAfter"
	| "insertBefore"
	| "delete";
export type SuggestionStatus = "pending" | "accepted" | "rejected";

export interface Suggestion {
	id: string; // "s" + 4-hex
	ref: string;
	kind: SuggestionKind;
	status: SuggestionStatus;
	by: string;
	markdown?: string; // omitted for kind=delete
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
	 *   comment.added | comment.replied | comment.resolved | comment.reopened
	 *   suggestion.added | suggestion.accepted | suggestion.rejected
	 *   file.externallyEdited  — writer unknown (chokidar / external tool)
	 *   file.rawWritten        — writer known (by: "ai:<id>"), emitted by Tier-1 raw-fs write
	 */
	type: string;
	at: string;
	by: string;
	[k: string]: unknown;
}

export interface SpanAttrs {
	spanId: string;
	origin: "ai" | "human";
	basis?: string;
	basisDetail?: string;
	by: string;
	at: string;
	inResponseTo?: string;
}

export interface Sidecar {
	schemaVersion: 1;
	path: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	// Map of block.ref -> current text fingerprint (sha256 of block markdown, first 12 hex).
	refMap: Record<string, { textHash: string; lastSeenAt: string }>;
	// History of ref renames. Old ref -> new ref, kept for ONE generation.
	refAliases: Record<string, string>;
	comments: Comment[];
	suggestions: Suggestion[];
	archivedSuggestions: Suggestion[];
	events: ProofEvent[];
	nextEventId: number;
	lastAck: Record<string, number>; // by -> eventId
	fingerprint: string; // last-known sha256 of the .md file
	blockProvenance?: Record<string, SpanAttrs>; // for blocks we can't wrap inline
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
	| { type: "comment.add"; ref?: string; lineAnchor?: LineAnchor; text: string }
	| { type: "comment.reply"; commentId: string; text: string }
	| { type: "comment.resolve"; commentId: string }
	| { type: "comment.reopen"; commentId: string }
	| {
			type: "suggestion.add";
			ref: string;
			kind: SuggestionKind;
			markdown?: string;
			basis?: string;
			basisDetail?: string;
			status?: SuggestionStatus;
	  }
	| { type: "suggestion.accept"; suggestionId: string }
	| { type: "suggestion.reject"; suggestionId: string };

export interface Snapshot {
	path: string;
	revision: number;
	createdAt: string;
	updatedAt: string;
	fingerprint: string;
	blocks: Block[];
	comments: Comment[]; // unresolved + resolved (separately by client)
	suggestions: Suggestion[]; // pending only by default
	lastEventId: number;
}
