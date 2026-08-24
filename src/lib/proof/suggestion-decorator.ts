import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { diffWords } from "./word-diff";
import type { Block, Suggestion } from "./types";

export const SUGGESTION_DECORATOR_KEY = new PluginKey<DecorationSet>(
	"suggestionDecorator",
);
export const SUGGESTION_DECORATOR_REFRESH_META = "suggestionDecorator:refresh";

export type SuggestionDecorationDescriptor =
	| {
			suggestionId: string;
			kind: Suggestion["kind"];
			role: "block";
			type: "node";
			from: number;
			to: number;
			className: string;
			attrs: Record<string, string>;
		}
	| {
			suggestionId: string;
			kind: Suggestion["kind"];
			role: "inline-delete";
			type: "inline";
			from: number;
			to: number;
			className: string;
			attrs: Record<string, string>;
		}
	| {
			suggestionId: string;
			kind: Suggestion["kind"];
			role: "ghost";
			type: "widget";
			from: number;
			side: -1 | 1;
			markdown: string;
		}
	| {
			suggestionId: string;
			kind: Suggestion["kind"];
			role: "insert";
			type: "widget";
			from: number;
			side: -1 | 1;
			text: string;
		};

export interface SuggestionDecoratorData {
	suggestions: readonly Suggestion[];
	blocks: readonly Block[];
}

export interface SuggestionDecoratorController {
	plugin: Plugin<DecorationSet>;
	update(data: SuggestionDecoratorData): void;
	refresh(view: EditorView): void;
}

/**
 * Map block refs to PM positions and describe every pending suggestion.
 * This function deliberately has no DOM or editor dependency, making anchor
 * reconciliation testable with a ProseMirror document in a node test.
 */
export function mapSuggestionDecorations(
	suggestions: readonly Suggestion[],
	doc: PMNode,
	blocks: readonly Block[],
): SuggestionDecorationDescriptor[] {
	const positions = new Map<string, { from: number; to: number; node: PMNode }>();
	let index = 0;
	doc.forEach((node, offset) => {
		const block = blocks[index];
		if (block) positions.set(block.ref, { from: offset, to: offset + node.nodeSize, node });
		index += 1;
	});

	const descriptors: SuggestionDecorationDescriptor[] = [];
	for (const suggestion of suggestions) {
		if (suggestion.status !== "pending" || suggestion.stale) continue;
		const position = positions.get(suggestion.ref);
		if (!position) continue;

		if (suggestion.kind === "replace" || suggestion.kind === "delete") {
			descriptors.push({
				suggestionId: suggestion.id,
				kind: suggestion.kind,
				role: "block",
				type: "node",
				from: position.from,
				to: position.to,
				className:
					suggestion.kind === "delete"
						? "suggestion-tracked-change border-l-2 border-destructive line-through"
						: "suggestion-tracked-change border-l-2 border-success",
				attrs: {
					"data-suggestion-id": suggestion.id,
					"data-suggestion-kind": suggestion.kind,
				},
			});

			if (
				suggestion.kind === "replace" &&
				suggestion.markdown &&
				position.node.content.size === position.node.textContent.length
			) {
				const contentStart = position.from + 1;
				let cursor = 0;
				for (const part of diffWords(position.node.textContent, suggestion.markdown)) {
					if (part.type === "delete") {
						descriptors.push({
							suggestionId: suggestion.id,
							kind: suggestion.kind,
							role: "inline-delete",
							type: "inline",
							from: contentStart + cursor,
							to: contentStart + cursor + part.text.length,
							className: "line-through text-destructive",
							attrs: {
								"data-suggestion-id": suggestion.id,
								"data-suggestion-kind": suggestion.kind,
							},
						});
						cursor += part.text.length;
					} else if (part.type === "insert") {
						descriptors.push({
							suggestionId: suggestion.id,
							kind: suggestion.kind,
							role: "insert",
							type: "widget",
							from: contentStart + cursor,
							side: 1,
							text: part.text,
						});
					} else {
						cursor += part.text.length;
					}
				}
			}
		}

		const isBefore = suggestion.kind === "insertBefore";
		const anchor = isBefore || suggestion.kind === "replace" || suggestion.kind === "delete"
			? position.from
			: position.to;
		const side: -1 | 1 = isBefore || suggestion.kind !== "insertAfter" ? -1 : 1;
		if (suggestion.kind === "insertBefore" || suggestion.kind === "insertAfter") {
			descriptors.push({
				suggestionId: suggestion.id,
				kind: suggestion.kind,
				role: "ghost",
				type: "widget",
				from: anchor,
				side,
				markdown: suggestion.markdown ?? "",
			});
		}
	}
	return descriptors;
}

function widgetElement(
	descriptor: Extract<SuggestionDecorationDescriptor, { type: "widget" }>,
	suggestion: Suggestion,
): HTMLElement {
	if (descriptor.role === "insert") {
		const inserted = document.createElement("span");
		inserted.className = "mx-0.5 text-success underline";
		inserted.textContent = descriptor.text ?? "";
		inserted.setAttribute("data-suggestion-id", suggestion.id);
		inserted.setAttribute("data-suggestion-insert", "true");
		inserted.contentEditable = "false";
		return inserted;
	}

	const ghost = document.createElement("span");
	ghost.className =
		"mx-1 inline rounded border border-dashed border-success/60 px-1 text-sm text-success underline decoration-dashed underline-offset-2 whitespace-pre-wrap";
	ghost.textContent = descriptor.markdown || "(empty suggestion)";
	ghost.setAttribute("data-suggestion-id", suggestion.id);
	ghost.setAttribute("data-suggestion-ghost", "true");
	ghost.contentEditable = "false";
	return ghost;
}

function buildDecorations(
	state: EditorState,
	data: SuggestionDecoratorData,
): DecorationSet {
	const descriptors = mapSuggestionDecorations(data.suggestions, state.doc, data.blocks);
	const byId = new Map(data.suggestions.map((suggestion) => [suggestion.id, suggestion]));
	const decorations = descriptors.map((descriptor) => {
		const suggestion = byId.get(descriptor.suggestionId);
		if (!suggestion) return null;
		if (descriptor.type === "node") {
			return Decoration.node(descriptor.from, descriptor.to, {
				class: descriptor.className,
				...descriptor.attrs,
			});
		}
		if (descriptor.type === "inline") {
			return Decoration.inline(descriptor.from, descriptor.to, {
				class: descriptor.className,
				...descriptor.attrs,
			});
		}
		return Decoration.widget(
			descriptor.from,
			() => widgetElement(descriptor, suggestion),
			{
				side: descriptor.side,
				key: `${descriptor.suggestionId}:${descriptor.role}:${descriptor.from}`,
			},
		);
	});
	return DecorationSet.create(state.doc, decorations.filter((decoration): decoration is Decoration => decoration !== null));
}

export const buildSuggestionDecorationDescriptors = mapSuggestionDecorations;
export const buildSuggestionDecorations = mapSuggestionDecorations;

export function createSuggestionDecoratorPlugin(
	initial: SuggestionDecoratorData = { suggestions: [], blocks: [] },
): SuggestionDecoratorController {
	let data = initial;
	const plugin = new Plugin<DecorationSet>({
		key: SUGGESTION_DECORATOR_KEY,
		state: {
			init: (_config, state) => buildDecorations(state, data),
			apply(tr: Transaction, old: DecorationSet, _oldState, newState) {
				if (tr.getMeta(SUGGESTION_DECORATOR_REFRESH_META)) {
					return buildDecorations(newState, data);
				}
				if (!tr.docChanged) return old;
				return old.map(tr.mapping, tr.doc);
			},
		},
		props: {
			decorations(state) {
				return SUGGESTION_DECORATOR_KEY.getState(state) ?? DecorationSet.empty;
			},
		},
	});
	return {
		plugin,
		update(next) {
			data = next;
		},
		refresh(view) {
			view.dispatch(view.state.tr.setMeta(SUGGESTION_DECORATOR_REFRESH_META, true));
		},
	};
}

export function suggestionDecoratorPlugin(data: SuggestionDecoratorData = { suggestions: [], blocks: [] }): Plugin<DecorationSet> {
	return createSuggestionDecoratorPlugin(data).plugin;
}
