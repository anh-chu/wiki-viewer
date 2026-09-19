import { type Node, type Schema } from "@tiptap/pm/model";
export type SuggestionId = string | number;
export declare const suggestionIdValidate = "number|string";
export declare function parseSuggestionId(id: string): SuggestionId;
export declare function generateNextNumberId(schema: Schema, doc?: Node): number;
