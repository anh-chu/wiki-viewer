import { type Node } from "@tiptap/pm/model";
import { type Command, type EditorState } from "@tiptap/pm/state";
import { type EditorView } from "@tiptap/pm/view";
import { type SuggestionId } from "./generateId.js";
export declare function applySuggestionsToNode(node: Node): Node;
export declare function applySuggestionsToRange(doc: Node, from: number, to: number): import("prosemirror-model").Slice;
/**
 * Command that applies all tracked changes in a document.
 *
 * This means that all content within deletion marks will be deleted.
 * Insertion marks and modification marks will be removed, and their
 * contents left in the doc.
 */
export declare function applySuggestions(state: EditorState, dispatch?: EditorView["dispatch"]): boolean;
/**
 * Command that applies all tracked changes in specified range.
 *
 * This means that all content within deletion marks will be deleted.
 * Insertion marks and modification marks will be removed, and their
 * contents left in the doc.
 */
export declare function applySuggestionsInRange(from?: number, to?: number): Command;
/**
 * Command that applies a given tracked change to a document.
 *
 * This means that all content within the deletion mark will be deleted.
 * The insertion mark and modification mark will be removed, and their
 * contents left in the doc.
 */
export declare function applySuggestion(suggestionId: SuggestionId, from?: number, to?: number): Command;
/**
 * Command that reverts all tracked changes in a document.
 *
 * This means that all content within insertion marks will be deleted.
 * Deletion marks will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */
export declare function revertSuggestions(state: EditorState, dispatch?: EditorView["dispatch"]): boolean;
/**
 * Command that reverts all tracked changes in specified range.
 *
 * This means that all content within insertion marks will be deleted.
 * Deletion marks will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */
export declare function revertSuggestionsInRange(from?: number, to?: number): Command;
/**
 * Command that reverts a given tracked change in a document.
 *
 * This means that all content within the insertion mark will be deleted.
 * The deletion mark will be removed, and their contents left in the doc.
 * Modifications tracked in modification marks will be reverted.
 */
export declare function revertSuggestion(suggestionId: SuggestionId, from?: number, to?: number): Command;
/**
 * Command that updates the selection to cover an existing change.
 */
export declare function selectSuggestion(suggestionId: SuggestionId): Command;
/** Command that enables suggest changes */
export declare function enableSuggestChanges(state: EditorState, dispatch?: EditorView["dispatch"]): boolean;
/** Command that disables suggest changes */
export declare function disableSuggestChanges(state: EditorState, dispatch?: EditorView["dispatch"]): boolean;
/** Command that toggles suggest changes on or off */
export declare function toggleSuggestChanges(state: EditorState, dispatch?: EditorView["dispatch"]): boolean;
