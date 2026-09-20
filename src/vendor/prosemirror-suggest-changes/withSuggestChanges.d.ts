import { type Schema, type Node } from "@tiptap/pm/model";
import { type EditorState, type Transaction } from "@tiptap/pm/state";
import { type EditorView } from "@tiptap/pm/view";
import { type SuggestionId } from "./generateId.js";
/**
 * Given a standard transaction from ProseMirror, produce
 * a new transaction that tracks the changes from the original,
 * rather than applying them.
 *
 * For each type of step, we implement custom behavior to prevent
 * deletions from being removed from the document, instead adding
 * deletion marks, and ensuring that all insertions have insertion
 * marks.
 */
export declare function transformToSuggestionTransaction(originalTransaction: Transaction, state: EditorState, generateId?: (schema: Schema, doc?: Node) => SuggestionId): Transaction;
/**
 * A `dispatchTransaction` decorator. Wrap your existing `dispatchTransaction`
 * function with `withSuggestChanges`, or pass no arguments to use the default
 * implementation (`view.setState(view.state.apply(tr))`).
 *
 * The result is a `dispatchTransaction` function that will intercept
 * and modify incoming transactions when suggest changes is enabled.
 * These modified transactions will suggest changes instead of directly
 * applying them, e.g. by marking a range with the deletion mark rather
 * than removing it from the document.
 */
export declare function withSuggestChanges(dispatchTransaction?: EditorView["dispatch"], generateId?: (schema: Schema, doc?: Node) => SuggestionId): EditorView["dispatch"];
