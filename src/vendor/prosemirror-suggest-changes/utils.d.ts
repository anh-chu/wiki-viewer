import { type MarkType, type Schema } from "@tiptap/pm/model";
export interface SuggestionMarks {
    insertion: MarkType;
    deletion: MarkType;
    modification: MarkType;
}
/**
 * Get the suggestion mark types from a schema, with proper error handling.
 * Throws an error if any of the required marks are not found.
 */
export declare function getSuggestionMarks(schema: Schema): SuggestionMarks;
