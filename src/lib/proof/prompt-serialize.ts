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
	/** modify suggestions: the attribute's new value, raw (not display-rendered). */
	newValue?: unknown;
	/**
	 * The saved file's exact text for this annotation's target — the whole
	 * `<del data-id="2">eal</del>` element as the file writes it. Quoted verbatim
	 * into the prompt as `source_match`, so the receiving agent performs a literal
	 * replacement instead of parsing tracked-change tags. Undefined when the mark
	 * is not in the saved file; such an item is excluded (see `buildPromptFromAnnotations`).
	 */
	sourceMatch?: string;
	/** alter suggestions: the attribute's old value, as the file has it. */
	baseValue?: unknown;
	/** True when `blockText` already contains the mark's tag. */
	embedded?: boolean;
	blockText?: string;
	/**
	 * The exact words the user commented on, when the comment recorded a selection.
	 *
	 * This is the comment's precise locator — the counterpart of a suggestion's
	 * `source_match` — and it stays exact where `blockText` may be a 5 KB block.
	 */
	selectedText?: string;
	currentText?: string;
	lineStart?: number;
	lineEnd?: number;
}

/**
 * The exact `<ins>`/`<del>` element the file holds for one suggestion id.
 *
 * This is what makes an exported edit executable: the agent replaces these bytes
 * with their content (insertion) or with nothing (deletion), matched uniquely in
 * the file, instead of interpreting tag semantics to discover which of several
 * tags in a block is its target.
 *
 * Returns undefined when the element is not found — a mark the file does not
 * carry cannot be exported, and the caller omits the annotation rather than
 * inventing a target.
 */
export function extractTaggedElement(markdown: string, tag: string, id: unknown): string | undefined {
	const open = `<${tag} data-id="${String(id)}">`;
	const at = markdown.indexOf(open);
	if (at < 0) return undefined;
	const close = `</${tag}>`;
	const end = markdown.indexOf(close, at + open.length);
	if (end < 0) return undefined;
	return markdown.slice(at, end + close.length);
}

/** Minimal comment shape accepted by the mapper, including legacy snapshots. */
export type PromptComment = {
	ref?: Comment["ref"];
	lineAnchor?: Comment["lineAnchor"];
	/** Exact words the user selected. The comment's real locator in the file. */
	textAnchor?: Comment["textAnchor"];
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

/**
 * Shorten a quoted block for a suggestion, where the block is supporting context
 * rather than the locator — `source_match` carries the precision.
 *
 * NOT applied to a comment's block: that quote is the comment's only locator, so
 * truncating it (or flattening its newlines) would leave an agent with a string it
 * cannot match against the file.
 */
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

/**
 * The operation a suggestion asks for, in imperative terms.
 *
 * Deliberately separate from `sourceMatch`: the operation says WHAT to do, the
 * match says WHERE. An agent that reads only the operation still knows the edit;
 * one that reads both can do it by literal replacement without parsing tags.
 */
function operationOf(item: PromptItem): string {
	switch (item.suggestionKind) {
		case "insert":
			return "insert";
		case "remove":
		case "delete":
			return "delete";
		case "modify":
			return "modify";
		default:
			return "replace";
	}
}

/**
 * The words this annotation concerns.
 *
 * For an insertion that is the text added; for a deletion it is the text removed —
 * naming it is the whole point, because "apply this suggested deletion" left the
 * agent to find its target among every tag in the block. A `modify` carries
 * attribute values instead, so it has no payload here.
 */
function payloadOf(item: PromptItem): string | undefined {
	if (item.suggestionKind === "modify") return undefined;
	return item.proposed;
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
		case "remove":
			// The payload — the words to delete — is named explicitly. The old form
			// ("apply this suggested deletion") left the agent to find its target
			// among every tag in the anchor, which is unanswerable when a block
			// carries several. Quote it when the file holds a mark with no tag yet.
			return item.proposed === undefined
				? `Suggestion on ${anchor}: delete this text`
				: `Suggestion on ${anchor}: delete the text ${JSON.stringify(item.proposed)}`;
		case "insert":
			return item.proposed === undefined
				? `Suggestion on ${anchor}: insert this text`
				: `Suggestion on ${anchor}: insert the text ${JSON.stringify(item.proposed)}`;
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
 * Syntax legend for tracked-change tags. Kept because `source_match` values are
 * quoted verbatim from the file, so an agent that reads them benefits from knowing
 * what the tags mean — but it is no longer the ONLY way to identify a target.
 */
const MARK_LEGEND = [
	"Mark legend — `source_match` values are quoted verbatim from the file:",
	`  <ins data-id="N">text</ins> — a suggested insertion, not yet applied: replace the tag with its text.`,
	`  <del data-id="N">text</del> — a suggested deletion, not yet applied: remove the tag and its text.`,
	`  <span data-type="modification" ...>...</span> — a suggested block-attribute change (e.g. heading level, code fence language); apply the change the item describes.`,
].join("\n");

const isMarkSuggestion = (item: PromptItem) =>
	item.kind === "suggestion" &&
	(item.suggestionKind === "insert" ||
		item.suggestionKind === "remove" ||
		item.suggestionKind === "modify");

/**
 * Whether this item can be exported at all.
 *
 * Copy-as-prompt exports the SAVED file. A tracked mark is actionable only when
 * its element is in that file, so an unsaved mark is dropped: it has no
 * `source_match`, and an instruction with no target is worse than none. Marks and
 * legacy record-shaped suggestions are distinguished by `sourceMatch` being
 * present/absent vs. `embedded` never having been set — a legacy item has no tag
 * to look for and is exported on its quoted block instead, as it always was.
 */
function isExportable(item: PromptItem): boolean {
	if (item.kind === "comment" || item.kind === "instruction") return true;
	// The mark path sets `embedded` and looks for the element in the file: a mark
	// whose tag is NOT there is editor-only state, so it is dropped. A legacy
	// record-shaped suggestion leaves `embedded` undefined (it has no tag to look
	// for) and exports on its quoted block, exactly as it always did.
	return item.embedded !== false;
}
/**
 * One JSON record per annotation: the operation, the payload, and the exact
 * file text to replace.
 *
 * The payload is named in its own field rather than left implicit in a quoted
 * anchor. `source_match` is what makes the edit executable without tag parsing —
 * it is the file's own bytes, so the agent does a literal unique replacement.
 */
interface PromptRecord {
	id: number;
	kind: PromptItemKind;
	operation: string;
	/** The words the operation adds (insertions/replacements). */
	text?: string;
	/** The saved file's exact element for this annotation. */
	source_match?: string;
	/** What `source_match` becomes; empty string for a deletion. */
	replacement?: string;
	/** The file's current attribute value (modify only). */
	from?: unknown;
	/** The requested attribute value (modify only). */
	to?: unknown;
	/** The block the annotation sits in, as the file has it. */
	block?: string;
	/** The exact words a comment covers, when the user selected text. */
	selected_text?: string;
	comment?: string;
	replies?: ReadonlyArray<{ by?: string; text: string }>;
}

function toRecord(item: PromptItem, id: number): PromptRecord {
	const base: PromptRecord = { id, kind: item.kind, operation: item.kind === "suggestion" ? operationOf(item) : "comment" };
	if (item.kind === "comment" || item.kind === "instruction") {
		const turns = item.turns ?? [{ text: item.text ?? "" }];
		const [first, ...replies] = turns;
		base.comment = first?.text ?? "";
		if (replies.length > 0) base.replies = replies.map((turn) => ({ by: turn.by, text: turn.text }));
		// `selected_text` is the comment's precise locator when the user selected
		// words — the counterpart of a suggestion's `source_match`. With it, the
		// block is mere context and gets capped. Without a selection the block is
		// the comment's ONLY locator, so it goes verbatim and uncapped: flattening
		// or truncating it would produce a string an agent cannot match against
		// the file, which defeats the comment entirely.
		if (item.selectedText) {
			base.selected_text = item.selectedText;
			if (item.blockText) base.block = capBlockText(item.blockText);
		} else if (item.blockText) {
			base.block = item.blockText;
		}
		return base;
	}

	const block = item.blockText ? capBlockText(item.blockText) : undefined;
	const payload = payloadOf(item);
	if (payload !== undefined) base.text = payload;

	if (item.suggestionKind === "modify") {
		// Raw values, not the display strings the prose path used: JSON carries
		// `"ts"` as a string and `2` as a number, so an agent reads the actual
		// attribute value instead of a pre-quoted rendering of it.
		if (block) base.block = block;
		base.from = item.baseValue;
		base.to = item.newValue;
		return base;
	}
	if (item.sourceMatch) {
		// No `block` here: `source_match` locates the edit uniquely, and repeating a
		// truncated block on every record of a busy list is noise, not context.
		base.source_match = item.sourceMatch;
		base.replacement = item.suggestionKind === "remove" ? "" : (payload ?? "");
		return base;
	}
	// A legacy record-shaped suggestion has no element to match, so its block is
	// the only locator it has.
	if (block) base.block = block;
	return base;
}

/**
 * Serialize existing annotations into a prompt. This function has no side effects.
 *
 * Shape: a short prose instruction, then the annotations as JSON. Prose alone
 * could not express this reliably — it has no way to bind an operation to its
 * target except by quoting, and a block carrying several suggestions makes every
 * quote ambiguous. JSON gives each annotation its own record, so the operation,
 * the payload, and the exact file text are named rather than inferred.
 *
 * Annotations whose mark is not in the saved file are EXCLUDED: the prompt edits
 * the file on disk, and an unsaved mark has no `source_match` to replace, so
 * including it would hand the agent an instruction it cannot carry out.
 */
export function buildPromptFromAnnotations(path: string, items: PromptItem[]): string {
	const included = items.filter(isExportable);
	const records = included.map((item, index) => toRecord(item, index + 1));
	const lines = [
		`Edit the file \`${path}\` using the annotations below.`,
		"",
		"Each annotation names its operation and target. Apply every suggestion; comments are",
		"feedback, not replacement text. For a record with `source_match`, replace that exact",
		"text with `replacement`, matched uniquely in the file. Do not reformat or rewrite",
		"unrelated content, and do not carry out a change that is already applied.",
		"",
		JSON.stringify({ file: path, annotations: records }, null, 2),
	];
	if (included.some(isMarkSuggestion)) lines.push("", MARK_LEGEND);
	return lines.join("\n");
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
				selectedText: comment.textAnchor?.selectedText || undefined,
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
	 * The exact tagged element the saved FILE holds for this mark
	 * (`<del data-id="2">eal</del>`), quoted verbatim so the receiving agent can
	 * replace it literally. Undefined for an unsaved mark — editor-only state,
	 * which Copy-as-prompt excludes.
	 */
	sourceMatch?: string;
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
			sourceMatch: mark.sourceMatch,
			// Marks always carry this, so `isExportable` can tell a mark that was not
			// found in the saved file from a legacy record-shaped suggestion that has
			// no tag to look for. A `modify` is attribute-only — no element to match —
			// and the mapper sees it as present.
			embedded: mark.sourceMatch !== undefined || mark.kind === "modify",
		};
		if (mark.kind === "remove") {
			// The mark keeps the deleted words visible, so `text` IS the payload:
			// the prompt names exactly those words to delete.
			return { ...base, suggestionKind: "remove" as const, proposed: mark.text };
		}
		if (mark.kind === "insert") {
			return { ...base, suggestionKind: "insert" as const, proposed: mark.text };
		}
		return {
			...base,
			suggestionKind: "modify" as const,
			attrName: mark.attrName ?? undefined,
			baseValue: mark.previousValue,
			newValue: mark.newValue,
			currentText: describeAttrValue(mark.previousValue),
			proposed: describeAttrValue(mark.newValue),
		};
	});
}
