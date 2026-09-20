import { type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type ReplaceStep, type Step } from "@tiptap/pm/transform";
import { type SuggestionId } from "./generateId.js";
/**
 * Transform a replace step into its equivalent tracked steps.
 *
 * Any deletions of slices that are _not_ within existing
 * insertion marks will be replaced with addMark steps that add
 * deletion marks to those ranges.
 *
 * Any deletions of slices that _are_ within existing insertion
 * marks will actually be deleted.
 *
 * Any slices that are to be inserted will also be marked with
 * insertion marks.
 *
 * If a deletion begins at the very end of a textblock, a zero-width
 * space will be inserted at the end of that texblock and given
 * a deletion mark.
 *
 * Similarly, if a deletion ends at the very beginning fo a textblock,
 * a zero-width space will be inserted at the beginning of that
 * textblock and given a deletion mark.
 *
 * If an insertion slice is open on either end, and there is no content
 * adjacent to the open end(s), zero-width spaces
 * will be added at the open end(s) and given insertion marks.
 *
 * After all of the above have been evaluated, if the resulting
 * insertion or deletion marks abut or join existing marks, they
 * will be joined and given the same ids. Any no-longer-necessary
 * zero-width spaces will be removed.
 */
export declare function suggestReplaceStep(trackedTransaction: Transaction, state: EditorState, doc: Node, step: ReplaceStep, prevSteps: Step[], suggestionId: SuggestionId): boolean;
