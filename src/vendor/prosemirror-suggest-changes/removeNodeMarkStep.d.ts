import { type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type RemoveNodeMarkStep, type Step } from "@tiptap/pm/transform";
import { type SuggestionId } from "./generateId.js";
/**
 * Transform a remove node mark step into its equivalent tracked steps.
 *
 * Remove node mark steps are processed normally, and then a modification
 * mark is added to the node as well, to track the change.
 */
export declare function suggestRemoveNodeMarkStep(trackedTransaction: Transaction, state: EditorState, _doc: Node, step: RemoveNodeMarkStep, prevSteps: Step[], suggestionId: SuggestionId): boolean;
