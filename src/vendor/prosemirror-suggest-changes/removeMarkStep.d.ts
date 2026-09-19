import { type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type RemoveMarkStep, type Step } from "@tiptap/pm/transform";
import { type SuggestionId } from "./generateId.js";
/**
 * Transform a remove mark step into its equivalent tracked steps.
 *
 * Add mark steps are treated as replace steps in this model. An
 * equivalent replace step will be generated, and then processed via
 * trackReplaceStep().
 */
export declare function suggestRemoveMarkStep(trackedTransaction: Transaction, state: EditorState, doc: Node, step: RemoveMarkStep, prevSteps: Step[], suggestionId: SuggestionId): boolean;
