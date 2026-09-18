/**
 * Word-level diff for suggestion redlines.
 *
 * REPLACES the hand-rolled 64-line LCS in the original `word-diff.ts`
 * (Phase 2b). `diff` (jsdiff) is one of the most-depended-on packages in the
 * ecosystem and does the same job with a better algorithm and a maintained
 * edge-case surface.
 *
 * WHY THE TOKENIZER IS STILL OURS
 * -------------------------------
 * The redline splits text into words, whitespace runs and individual
 * punctuation, and it must preserve the EXACT source text across the parts —
 * offsets are applied to ProseMirror positions, so a lost or duplicated space
 * shifts the highlight. `diffWords` has its own boundary rules and does not
 * guarantee that property, so we tokenize, diff, then map back to token spans.
 *
 * Output shape is unchanged (`WordDiffPart[]`), so every existing consumer keeps
 * working; `suggestion-decorator.ts` imports only `diffWords`.
 */
import { diffArrays } from "diff";

export type WordDiffPart = {
	text: string;
	type: "equal" | "insert" | "delete";
};

/**
 * Split text into words, whitespace runs, and individual punctuation/symbols.
 * Keeping whitespace as tokens preserves the exact source text in each part.
 */
function tokenize(text: string): string[] {
	return text.match(/[\p{L}\p{M}\p{N}_]+|\s+|[^\p{L}\p{M}\p{N}_\s]/gu) ?? [];
}

/**
 * Return a deterministic word-level diff from current text to proposed text.
 *
 * `diffArrays` yields the same equal/added/removed shape the LCS produced, and
 * adjacent same-type parts are merged so consumers see one span per run.
 */
export function diffWords(current: string, proposed: string): WordDiffPart[] {
	const changes = diffArrays(tokenize(current), tokenize(proposed));

	const parts: WordDiffPart[] = [];
	const append = (text: string, type: WordDiffPart["type"]) => {
		if (!text) return;
		const previous = parts.at(-1);
		if (previous?.type === type) previous.text += text;
		else parts.push({ text, type });
	};

	for (const change of changes) {
		const text = change.value.join("");
		if (change.added) append(text, "insert");
		else if (change.removed) append(text, "delete");
		else append(text, "equal");
	}

	return parts;
}