import { type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type AddNodeMarkStep, type Step } from "@tiptap/pm/transform";
import { type SuggestionId } from "./generateId.js";
/**
 * Transform an add node mark step into its equivalent tracked steps.
 *
 * Add node mark steps are processed normally, and then a modification
 * mark is added to the node as well, to track the change.
 */
export declare function trackAddNodeMarkStep(trackedTransaction: Transaction, state: EditorState, _doc: Node, step: AddNodeMarkStep, prevSteps: Step[], suggestionId: SuggestionId): boolean;
