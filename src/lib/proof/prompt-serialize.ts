import type {
	Comment,
	LineAnchor,
	Suggestion,
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
		case "insertAfter":
			return `Suggestion on ${anchor}: insert after ${anchor}\n${quoteIndented(item.proposed ?? "")}`;
		case "insertBefore":
			return `Suggestion on ${anchor}: insert before ${anchor}\n${quoteIndented(item.proposed ?? "")}`;
		case "replace":
		default:
			return `Suggestion on ${anchor}: replace with\n${quoteIndented(item.proposed ?? "")}`;
	}
}

/** Serialize existing annotations into a prompt. This function has no side effects. */
export function buildPromptFromAnnotations(path: string, items: PromptItem[]): string {
	const header = `Edit the file \`${path}\` (a Markdown document). Apply these changes:`;
	return [header, "", ...items.map((item, index) => `${index + 1}. ${formatPromptItem(item)}`)].join("\n");
}

/** Resolve an annotation to full readable text and, when available, its line range. */
export type SnippetResolver = (annotation: {
	ref?: string;
	lineAnchor?: LineAnchor;
}) => PromptAnchor | string | undefined;

const normalizeAnchor = (value: PromptAnchor | string | undefined): PromptAnchor | undefined =>
	typeof value === "string" ? { text: value } : value;

/** Map unresolved comments and pending suggestions into prompt items. */
export function mapAnnotationsToPromptItems(
	comments: readonly PromptComment[] = [],
	suggestions: readonly Suggestion[] = [],
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
