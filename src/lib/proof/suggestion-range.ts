import { diffWords } from "@/lib/proof/word-diff";
import type { SuggestionRange } from "@/lib/proof/types";

/**
 * Find one tight changed span in the original block markdown.
 *
 * A shared interior substring means edits are separated by unchanged text, so
 * the range is omitted rather than reporting a misleading broad span.
 */
export function computeSuggestionRange(
	original: string,
	edited: string,
): SuggestionRange | undefined {
	if (original === edited) return undefined;

	let prefix = 0;
	while (
		prefix < original.length &&
		prefix < edited.length &&
		original[prefix] === edited[prefix]
	) {
		prefix++;
	}

	let suffix = 0;
	while (
		prefix + suffix < original.length &&
		prefix + suffix < edited.length &&
		original[original.length - 1 - suffix] === edited[edited.length - 1 - suffix]
	) {
		suffix++;
	}

	const originalEnd = original.length - suffix;
	const editedEnd = edited.length - suffix;
	const originalChanged = original.slice(prefix, originalEnd);
	const editedChanged = edited.slice(prefix, editedEnd);

	// Equal prefix/suffix boundaries can produce multiple valid locations for
	// an insertion/deletion (for example, repeated text at both ends).
	if (
		prefix + suffix === Math.min(original.length, edited.length) &&
		(originalChanged.length === 0 || editedChanged.length === 0)
	) {
		const shorter = originalChanged.length === 0 ? original : edited;
		const longer = originalChanged.length === 0 ? edited : original;
		if (shorter.length > 0 && longer.endsWith(shorter)) return undefined;
	}

	// An equal non-whitespace word between changed parts indicates separated edits.
	const changedParts = diffWords(originalChanged, editedChanged);
	const firstChange = changedParts.findIndex((part) => part.type !== "equal");
	const lastChange = changedParts.findLastIndex((part) => part.type !== "equal");
	if (firstChange !== -1 && lastChange !== -1) {
		for (let i = firstChange + 1; i < lastChange; i++) {
			if (changedParts[i].type === "equal" && /\S/u.test(changedParts[i].text)) {
				return undefined;
			}
		}
	}

	return { start: prefix, end: originalEnd };
}
