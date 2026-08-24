import { diffWords } from "./word-diff";

export type BlockMergeResult =
	| { ok: true; merged: string }
	| { ok: false; reason: "conflict" };

interface ChangeSpan {
	start: number;
	end: number;
	replacement: string;
}

function changeSpans(base: string, variant: string): ChangeSpan[] {
	const spans: ChangeSpan[] = [];
	let baseOffset = 0;
	let active: ChangeSpan | undefined;

	const flush = () => {
		if (active) spans.push(active);
		active = undefined;
	};

	for (const part of diffWords(base, variant)) {
		if (part.type === "equal") {
			flush();
			baseOffset += part.text.length;
			continue;
		}

		if (!active) {
			active = { start: baseOffset, end: baseOffset, replacement: "" };
		}
		if (part.type === "delete") {
			active.end += part.text.length;
			baseOffset += part.text.length;
		} else {
			active.replacement += part.text;
		}
	}
	flush();
	return spans;
}

function overlaps(left: ChangeSpan, right: ChangeSpan): boolean {
	if (left.start === left.end && right.start === right.end) {
		return left.start === right.start;
	}
	if (left.start === left.end) {
		return left.start > right.start && left.start < right.end;
	}
	if (right.start === right.end) {
		return right.start > left.start && right.start < left.end;
	}
	return left.start < right.end && right.start < left.end;
}

/** Merge independent edits from proposed and current against one block base. */
export function mergeBlock(
	base: string,
	proposed: string,
	current: string,
): BlockMergeResult {
	if (base === current) return { ok: true, merged: proposed };

	const proposedSpans = changeSpans(base, proposed);
	const currentSpans = changeSpans(base, current);
	for (const proposedSpan of proposedSpans) {
		if (currentSpans.some((currentSpan) => overlaps(proposedSpan, currentSpan))) {
			return { ok: false, reason: "conflict" };
		}
	}

	const spans = [...currentSpans, ...proposedSpans].sort(
		(left, right) => left.start - right.start || left.end - left.start - (right.end - right.start),
	);
	let merged = "";
	let baseOffset = 0;
	for (const span of spans) {
		merged += base.slice(baseOffset, span.start);
		merged += span.replacement;
		baseOffset = span.end;
	}
	merged += base.slice(baseOffset);
	return { ok: true, merged };
}
