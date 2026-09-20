import { type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type AttrStep, type Step } from "@tiptap/pm/transform";
import { type SuggestionId } from "./generateId.js";
/**
 * Transform an attr mark step into its equivalent tracked steps.
 *
 * Attr steps are processed normally, and then a modification
 * mark is added to the node as well, to track the change.
 */
export declare function trackAttrStep(trackedTransaction: Transaction, state: EditorState, _doc: Node, step: AttrStep, prevSteps: Step[], suggestionId: SuggestionId): boolean;
