import type { Node as PMNode } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
			role: "ghost" | "badge";
			type: "widget";
			from: number;
			side: -1 | 1;
			markdown?: string;
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
	const positions = new Map<string, { from: number; to: number }>();
	let index = 0;
	doc.forEach((node, offset) => {
		const block = blocks[index];
		if (block) positions.set(block.ref, { from: offset, to: offset + node.nodeSize });
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
						? "suggestion-tracked-change bg-destructive-soft border-l-2 border-destructive line-through"
						: "suggestion-tracked-change bg-success-soft border-l-2 border-success",
				attrs: {
					"data-suggestion-id": suggestion.id,
					"data-suggestion-kind": suggestion.kind,
				},
			});
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
		// Badge remains a separate keyed widget so it survives mapping and can be
		// activated without making proposed content part of the PM document.
		descriptors.push({
			suggestionId: suggestion.id,
			kind: suggestion.kind,
			role: "badge",
			type: "widget",
			from: anchor,
			side,
		});
	}
	return descriptors;
}

function widgetElement(
	descriptor: Extract<SuggestionDecorationDescriptor, { type: "widget" }>,
	suggestion: Suggestion,
	onBadgeClick?: (suggestionId: string, element: HTMLElement) => void,
): HTMLElement {
	if (descriptor.role === "badge") {
		const badge = document.createElement("button");
		badge.type = "button";
		badge.textContent = "▾";
		badge.className =
			"inline-flex min-h-11 min-w-11 items-center justify-center align-middle text-base text-primary hover:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
		badge.setAttribute("aria-label", `Review suggestion by ${suggestion.by}`);
		badge.setAttribute("data-suggestion-id", suggestion.id);
		badge.setAttribute("data-suggestion-badge", "true");
		badge.contentEditable = "false";
		badge.addEventListener("mousedown", (event) => event.preventDefault());
		badge.addEventListener("click", () => onBadgeClick?.(suggestion.id, badge));
		return badge;
	}

	const ghost = document.createElement("div");
	ghost.className =
		"my-1 rounded border border-dashed border-success bg-success-soft px-3 py-2 text-sm text-foreground/80 whitespace-pre-wrap";
	ghost.textContent = descriptor.markdown || "(empty suggestion)";
	ghost.setAttribute("data-suggestion-id", suggestion.id);
	ghost.setAttribute("data-suggestion-ghost", "true");
	ghost.contentEditable = "false";
	return ghost;
}

function buildDecorations(
	state: EditorState,
	data: SuggestionDecoratorData,
	onBadgeClick?: (suggestionId: string, element: HTMLElement) => void,
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
		return Decoration.widget(
			descriptor.from,
			() => widgetElement(descriptor, suggestion, onBadgeClick),
			{ side: descriptor.side, key: `${descriptor.suggestionId}:${descriptor.role}` },
		);
	});
	return DecorationSet.create(state.doc, decorations.filter((decoration): decoration is Decoration => decoration !== null));
}

export const buildSuggestionDecorationDescriptors = mapSuggestionDecorations;
export const buildSuggestionDecorations = mapSuggestionDecorations;

export function createSuggestionDecoratorPlugin(
	initial: SuggestionDecoratorData = { suggestions: [], blocks: [] },
	onBadgeClick?: (suggestionId: string, element: HTMLElement) => void,
): SuggestionDecoratorController {
	let data = initial;
	const plugin = new Plugin<DecorationSet>({
		key: SUGGESTION_DECORATOR_KEY,
		state: {
			init: (_config, state) => buildDecorations(state, data, onBadgeClick),
			apply(tr: Transaction, old: DecorationSet, _oldState, newState) {
				if (tr.getMeta(SUGGESTION_DECORATOR_REFRESH_META)) {
					return buildDecorations(newState, data, onBadgeClick);
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
