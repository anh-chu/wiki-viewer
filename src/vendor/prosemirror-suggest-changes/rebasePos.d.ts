import { type Step } from "@tiptap/pm/transform";
/**
 * Rebase a position onto a new lineage of steps
 *
 * @param pos The position to rebase
 * @param back The old steps to undo, in the order they were originally applied
 * @param forth The new steps to map through
 */
export declare function rebasePos(pos: number, back: Step[], forth: Step[]): number;
