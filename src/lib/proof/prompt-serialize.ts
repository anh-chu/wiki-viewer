import type {
	Comment,
	LineAnchor,
	SuggestionKind,
} from "./types";

export type PromptItemKind = "comment" | "instruction" | "suggestion";

export interface PromptAnchor {
	/** Full readable block text (not an opaque block ref). */
	text: string;
	lineStart?: number;
	lineEnd?: number;
}

export interface PromptItem {
	/** Legacy fallback when no readable anchor can be resolved. */
	snippet?: string;
	kind: PromptItemKind;
	text?: string;
	turns?: ReadonlyArray<{ text: string; by?: string }>;
	proposed?: string;
	suggestionKind?: SuggestionKind;
	/** modify suggestions: the node attribute the change targets. */
	attrName?: string;
	/**
	 * The payload is already embedded in the anchor as a tracked-change tag
	 * (`<ins data-id>` / `<del data-id>` from the saved file), so the item
	 * needs no quoted copy of the words.
	 */
	embedded?: boolean;
	blockText?: string;
	currentText?: string;
	lineStart?: number;
	lineEnd?: number;
}

/** Minimal comment shape accepted by the mapper, including legacy snapshots. */
export type PromptComment = {
	ref?: Comment["ref"];
	lineAnchor?: Comment["lineAnchor"];
	id?: Comment["id"];
	resolved?: boolean;
	/** `"lost"` excludes the comment: its text is gone, so no snippet is honest. */
	anchorStatus?: Comment["anchorStatus"];
	kind?: Comment["kind"];
	instructionState?: Comment["instructionState"];
	fromCommentId?: Comment["fromCommentId"];
	text?: string;
	by?: string;
	turns?: ReadonlyArray<{ text: string; by?: string }>;
};

function lineAnchorSnippet(lineAnchor: LineAnchor): string {
	return lineAnchor.lineStart === lineAnchor.lineEnd
		? `line ${lineAnchor.lineStart}`
		: `lines ${lineAnchor.lineStart}-${lineAnchor.lineEnd}`;
}

function annotationSnippet(annotation: {
	ref?: string;
	lineAnchor?: LineAnchor;
}): string {
	return annotation.ref ?? (annotation.lineAnchor ? lineAnchorSnippet(annotation.lineAnchor) : "document");
}

function commentTurns(comment: PromptComment): ReadonlyArray<{ text: string; by?: string }> {
	if (comment.turns?.length) return comment.turns;
	return [{ text: comment.text ?? "", by: comment.by }];
}

function commentText(comment: PromptComment): string {
	return commentTurns(comment)[0]?.text ?? "";
}

function capBlockText(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length > 200 ? `${normalized.slice(0, 199).trimEnd()}…` : normalized;
}

function readableText(item: PromptItem): string {
	return capBlockText(item.blockText ?? item.currentText ?? item.snippet ?? "document");
}

function lineSuffix(item: PromptItem): string {
	if (item.lineStart === undefined) return "";
	const end = item.lineEnd ?? item.lineStart;
	return end === item.lineStart ? ` (line ${item.lineStart})` : ` (lines ${item.lineStart}-${end})`;
}

function quoteIndented(value: string): string {
	const lines = value.split("\n");
	return lines.map((line) => `   "${line}"`).join("\n");
}

/** Convert one prompt item to its numbered-item body, without its number. */
export function formatPromptItem(item: PromptItem): string {
	const anchor = `"${readableText(item)}"${lineSuffix(item)}`;
	if (item.kind === "comment" || item.kind === "instruction") {
		const turns = item.turns ?? [{ text: item.text ?? "" }];
		const [first, ...replies] = turns;
		const lines = [`Comment on paragraph ${anchor}:`, `   "${first?.text ?? ""}"`];
		for (const turn of replies) {
			lines.push(`   - ${turn.by ?? "unknown"}: ${turn.text}`);
		}
		return lines.join("\n");
	}

	switch (item.suggestionKind) {
		case "delete":
			return `Suggestion on ${anchor}: delete this block`;
		// Tracked-mark suggestions cover a run of text INSIDE a block, so the prompt
		// names the words rather than the block: "delete this block" on a mark that
		// covers three words would direct the agent to erase the paragraph. When the
		// saved file's anchor already embeds the mark tag, the words need no second
		// quote — the legend at the end of the prompt explains the tag syntax.
		case "remove":
			return item.embedded
				? `Suggestion on ${anchor}: apply this suggested deletion`
				: `Suggestion on ${anchor}: delete this text\n${quoteIndented(item.proposed ?? "")}`;
		case "insert":
			return item.embedded
				? `Suggestion on ${anchor}: apply this suggested insertion`
				: `Suggestion on ${anchor}: insert this text\n${quoteIndented(item.proposed ?? "")}`;
		case "modify":
			// The library only creates modifications over node attributes (heading
			// level, code fence language, …) — never over plain text.
			return `Suggestion on ${anchor}: change ${item.attrName ?? "this block"} from ${item.currentText ?? "(none)"} to ${item.proposed ?? "(none)"}`;
		case "insertAfter":
			return `Suggestion on ${anchor}: insert after ${anchor}\n${quoteIndented(item.proposed ?? "")}`;
		case "insertBefore":
			return `Suggestion on ${anchor}: insert before ${anchor}\n${quoteIndented(item.proposed ?? "")}`;
		case "replace":
		default:
			return `Suggestion on ${anchor}: replace with\n${quoteIndented(item.proposed ?? "")}`;
	}
}

/**
 * Syntax legend for tracked-change tags the quoted anchors may contain, appended
 * when the prompt includes mark-based suggestions. The saved file stores pending
 * suggestions as raw HTML (`to-markdown.ts` preserves them), so the receiving
 * agent needs to know what the tags mean and what applying them does.
 */
const MARK_LEGEND = [
	"Mark legend — the quoted anchors may contain tracked-change tags:",
	`  <ins data-id="N">text</ins> — a suggested insertion, not yet applied: replace the tag with its text.`,
	`  <del data-id="N">text</del> — a suggested deletion, not yet applied: remove the tag and its text.`,
	`  <span data-type="modification" ...>...</span> — a suggested block-attribute change (e.g. heading level, code fence language); apply the change the item describes.`,
].join("\n");

const isMarkSuggestion = (item: PromptItem) =>
	item.kind === "suggestion" &&
	(item.suggestionKind === "insert" ||
		item.suggestionKind === "remove" ||
		item.suggestionKind === "modify");

/** Serialize existing annotations into a prompt. This function has no side effects. */
export function buildPromptFromAnnotations(path: string, items: PromptItem[]): string {
	const header = `Edit the file \`${path}\` (a Markdown document). Apply these changes:`;
	const body = items.map((item, index) => `${index + 1}. ${formatPromptItem(item)}`);
	if (items.some(isMarkSuggestion)) body.push("", MARK_LEGEND);
	return [header, "", ...body].join("\n");
}

/** Resolve an annotation to full readable text and, when available, its line range. */
export type SnippetResolver = (annotation: {
	ref?: string;
	lineAnchor?: LineAnchor;
}) => PromptAnchor | string | undefined;

const normalizeAnchor = (value: PromptAnchor | string | undefined): PromptAnchor | undefined =>
	typeof value === "string" ? { text: value } : value;

/**
 * A suggestion record, as this serializer needs to see it.
 *
 * Declared structurally rather than imported: suggestions are document marks now, so
 * there is no `Suggestion` type to import. Callers that still hold record-shaped
 * suggestion data (a legacy prompt path, a test fixture) can pass it without this
 * module depending on a representation the app no longer writes.
 */
export interface PromptSuggestion {
	ref: string;
	kind?: SuggestionKind;
	markdown?: string;
	range?: { start: number; end: number };
	/** Legacy record fields, read only to describe a suggestion in a prompt. */
	status?: string;
	baseMarkdown?: string;
}

/** Map unresolved comments and pending suggestions into prompt items. */
export function mapAnnotationsToPromptItems(
	comments: readonly PromptComment[] = [],
	suggestions: readonly PromptSuggestion[] = [],
	resolveSnippet?: SnippetResolver,
): PromptItem[] {
	const anchorFor = (annotation: { ref?: string; lineAnchor?: LineAnchor }) => {
		const resolved = normalizeAnchor(resolveSnippet?.(annotation));
		if (resolved) {
			return {
				blockText: resolved.text,
				lineStart: resolved.lineStart,
				lineEnd: resolved.lineEnd,
			};
		}
		if (annotation.lineAnchor) {
			return {
				snippet: annotationSnippet(annotation),
				lineStart: annotation.lineAnchor.lineStart,
				lineEnd: annotation.lineAnchor.lineEnd,
			};
		}
		return { snippet: annotationSnippet(annotation) };
	};

	// A comment that has already been escalated into a draft instruction is
	// represented by that instruction (same ask) — serialize it once, not twice.
	const escalatedToDraft = new Set(
		comments
			.filter(
				(c) =>
					c.kind === "instruction" &&
					c.instructionState === "draft" &&
					typeof c.fromCommentId === "string",
			)
			.map((c) => c.fromCommentId as string),
	);

	const commentItems: PromptItem[] = comments
		.filter(
			(comment) =>
				comment.resolved !== true &&
				// A comment whose anchor is lost is kept on the record and shown as
				// detached, but it is NOT actionable: its text is gone, so any snippet
				// we attached would be a guess, and an agent would be handed an
				// instruction about a sentence that no longer exists. Cancellation used
				// to be what excluded these; now that they are kept, the exclusion has
				// to be explicit.
				comment.anchorStatus !== "lost" &&
				!(comment.kind !== "instruction" &&
					comment.id !== undefined &&
					escalatedToDraft.has(comment.id)) &&
				(comment.kind !== "instruction" ||
					(comment.instructionState !== "queued" &&
						comment.instructionState !== "sent" &&
						comment.instructionState !== "answered")),
		)
		.map((comment) => {
			const anchor = anchorFor(comment);
			return {
				...anchor,
				kind: comment.kind === "instruction" ? ("instruction" as const) : ("comment" as const),
				text: commentText(comment),
				turns: commentTurns(comment),
			};
		});

	const suggestionItems: PromptItem[] = suggestions
		.filter((suggestion) => suggestion.status === "pending")
		.map((suggestion) => {
			const anchor = anchorFor({ ref: suggestion.ref });
			return {
				...anchor,
				kind: "suggestion" as const,
				proposed: suggestion.markdown,
				currentText: suggestion.baseMarkdown,
				suggestionKind: suggestion.kind,
			};
		});

	return [...commentItems, ...suggestionItems];
}

/** Short alias for callers that already have sidecar annotation arrays. */
export const promptItemsFromAnnotations = mapAnnotationsToPromptItems;

/**
 * A tracked-changes mark, structurally — what the prompt needs and nothing more.
 *
 * Suggestions are document marks now (`<ins>`/`<del>`/modification), enumerated by the
 * editor's `trackedMarks`; this is that shape decoupled from ProseMirror so the mapper
 * stays testable without an editor.
 */
export interface PromptMarkSuggestion {
	kind: "insert" | "remove" | "modify";
	/** The text the mark covers, read from the live document. */
	text: string;
	/**
	 * The block the mark sits in, as the FILE has it (snapshot markdown), so the
	 * receiving agent can locate the anchor on disk. Undefined when the block
	 * could not be resolved this frame.
	 */
	blockText?: string;
	/**
	 * True when `blockText` already contains this mark's tag (the suggestion was
	 * saved, so the file carries `<ins data-id>` / `<del data-id>`): the item
	 * then says "apply this suggested …" without quoting the words again.
	 * False — e.g. an unsaved mark — falls back to quoting the payload.
	 */
	embedded?: boolean;
	/** modify only: the node attribute that changed. */
	attrName?: string | null;
	previousValue?: unknown;
	newValue?: unknown;
}

/** Render an attribute value for the prompt: quoted strings, `JSON` for objects. */
function describeAttrValue(value: unknown): string {
	if (value === null || value === undefined) return "(none)";
	if (typeof value === "string") return `"${value}"`;
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

/** Map tracked-changes marks into suggestion prompt items. */
export function mapMarkSuggestionsToPromptItems(
	marks: readonly PromptMarkSuggestion[],
): PromptItem[] {
	return marks.map((mark) => {
		// `document` when the block could not be resolved: a modify item's
		// `currentText` is an attribute VALUE, not anchor material, and the
		// anchor chain would otherwise quote it as the location.
		const base = {
			blockText: mark.blockText ?? "document",
			kind: "suggestion" as const,
			// Only meaningful for insert/remove: a modification is described by its
			// attribute values, which never embed in the anchor.
			embedded: mark.embedded ?? false,
		};
		if (mark.kind === "remove") {
			// The mark keeps the deleted words visible, so `text` IS the payload:
			// the agent removes exactly those words from the anchored block.
			return { ...base, suggestionKind: "remove" as const, proposed: mark.text };
		}
		if (mark.kind === "insert") {
			return { ...base, suggestionKind: "insert" as const, proposed: mark.text };
		}
		return {
			...base,
			suggestionKind: "modify" as const,
			attrName: mark.attrName ?? undefined,
			currentText: describeAttrValue(mark.previousValue),
			proposed: describeAttrValue(mark.newValue),
		};
	});
}
