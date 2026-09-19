import { type MarkSpec } from "@tiptap/pm/model";
export declare const deletion: MarkSpec;
export declare const insertion: MarkSpec;
export declare const modification: MarkSpec;
/**
 * Add the deletion, insertion, and modification marks to
 * the provided MarkSpec map.
 */
export declare function addSuggestionMarks<Marks extends string>(marks: Record<Marks, MarkSpec>): Record<Marks | "deletion" | "insertion" | "modification", MarkSpec>;
