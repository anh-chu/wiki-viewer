import type {
	Comment,
	LineAnchor,
	Suggestion,
	SuggestionKind,
} from "./types";

export type PromptItemKind = "comment" | "suggestion";

export interface PromptItem {
	snippet: string;
	kind: PromptItemKind;
	text?: string;
	proposed?: string;
	suggestionKind?: SuggestionKind;
}

/** Minimal comment shape accepted by the mapper, including legacy snapshots. */
export type PromptComment = {
	ref?: Comment["ref"];
	lineAnchor?: Comment["lineAnchor"];
	resolved?: boolean;
	kind?: Comment["kind"];
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

function commentText(comment: PromptComment): string {
	// The original ask (first turn) is what belongs in a prompt, not the whole
	// discussion thread. Fall back to a legacy flat `text` field.
	const firstTurn = comment.turns?.[0]?.text;
	if (firstTurn !== undefined) return firstTurn;
	return comment.text ?? "";
}

/** Convert one prompt item to its numbered-item body, without its number. */
export function formatPromptItem(item: PromptItem): string {
	if (item.kind === "comment") {
		return `\`${item.snippet}\`: ${item.text ?? ""}`;
	}

	switch (item.suggestionKind) {
		case "delete":
			return `\`${item.snippet}\`: delete this`;
		case "insertAfter":
		case "insertBefore":
			return `\`${item.snippet}\`: insert "${item.proposed ?? ""}"`;
		case "replace":
		default:
			return `\`${item.snippet}\`: replace with "${item.proposed ?? ""}"`;
	}
}

/**
 * Serialize existing annotations into a prompt. This function has no side
 * effects and intentionally only reads its arguments.
 */
export function buildPromptFromAnnotations(path: string, items: PromptItem[]): string {
	const header = `Edit the file \`${path}\` (a Markdown document). Apply these changes:`;
	return [header, "", ...items.map((item, index) => `${index + 1}. ${formatPromptItem(item)}`)].join("\n");
}

/**
 * Resolve a human-readable snippet for an annotation. Given the block `ref` (or
 * line anchor), return short readable text (e.g. the block's leading words)
 * instead of the opaque ref id. Return undefined to fall back to the ref id.
 */
export type SnippetResolver = (annotation: {
	ref?: string;
	lineAnchor?: LineAnchor;
}) => string | undefined;

/** Map unresolved comments and pending suggestions into prompt items. */
export function mapAnnotationsToPromptItems(
	comments: readonly PromptComment[] = [],
	suggestions: readonly Suggestion[] = [],
	resolveSnippet?: SnippetResolver,
): PromptItem[] {
	const snippetFor = (annotation: { ref?: string; lineAnchor?: LineAnchor }) =>
		resolveSnippet?.(annotation) ?? annotationSnippet(annotation);

	const commentItems: PromptItem[] = comments
		.filter((comment) => comment.resolved !== true)
		.map((comment) => ({
			snippet: snippetFor(comment),
			kind: "comment" as const,
			text: commentText(comment),
		}));

	const suggestionItems: PromptItem[] = suggestions
		.filter((suggestion) => suggestion.status === "pending")
		.map((suggestion) => ({
			snippet: snippetFor({ ref: suggestion.ref }),
			kind: "suggestion" as const,
			proposed: suggestion.markdown,
			suggestionKind: suggestion.kind,
		}));

	return [...commentItems, ...suggestionItems];
}

/** Short alias for callers that already have sidecar annotation arrays. */
export const promptItemsFromAnnotations = mapAnnotationsToPromptItems;
