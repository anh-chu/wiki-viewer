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

/** Return a deterministic word-level LCS diff from current text to proposed text. */
export function diffWords(current: string, proposed: string): WordDiffPart[] {
	const left = tokenize(current);
	const right = tokenize(proposed);
	const lengths = Array.from({ length: left.length + 1 }, () =>
		new Array<number>(right.length + 1).fill(0),
	);

	for (let i = left.length - 1; i >= 0; i -= 1) {
		for (let j = right.length - 1; j >= 0; j -= 1) {
			lengths[i][j] =
				left[i] === right[j]
					? lengths[i + 1][j + 1] + 1
					: Math.max(lengths[i + 1][j], lengths[i][j + 1]);
		}
	}

	const parts: WordDiffPart[] = [];
	const append = (text: string, type: WordDiffPart["type"]) => {
		if (!text) return;
		const previous = parts.at(-1);
		if (previous?.type === type) previous.text += text;
		else parts.push({ text, type });
	};

	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if (left[i] === right[j]) {
			append(left[i], "equal");
			i += 1;
			j += 1;
		} else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
			append(left[i], "delete");
			i += 1;
		} else {
			append(right[j], "insert");
			j += 1;
		}
	}
	while (i < left.length) {
		append(left[i], "delete");
		i += 1;
	}
	while (j < right.length) {
		append(right[j], "insert");
		j += 1;
	}

	return parts;
}
