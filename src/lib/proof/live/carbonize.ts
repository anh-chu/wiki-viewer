import { createHash } from "node:crypto";

export type CarbonizeInput = {
	source: string;
	baseHash: string;
	chosenVariantId: string;
	paramValues: Record<string, string | number>;
};

export type CarbonizeResult =
	| { ok: true; source: string }
	| { ok: false; code: "BASE_DRIFT" | "NO_MARKERS" | "NO_VARIANT"; detail?: string };

type ElementBlock = { start: number; end: number; innerStart: number; innerEnd: number; id: string };

/** Convert one accepted Impeccable carbonize scaffold into permanent source. */
export function carbonizeLiveVariant(input: CarbonizeInput): CarbonizeResult {
	const { source, baseHash, chosenVariantId, paramValues } = input;
	if (hashContent(source) !== baseHash) return { ok: false, code: "BASE_DRIFT" };

	const carbonizeTextStart = findAnyMarker(source, "impeccable-carbonize-start");
	const id = carbonizeTextStart >= 0 ? readMarkerId(source, carbonizeTextStart, "impeccable-carbonize-start") : null;
	const markerStart = carbonizeTextStart >= 0 ? findMarkerStart(source, carbonizeTextStart) : -1;
	if (markerStart < 0 || id === null) return { ok: false, code: "NO_MARKERS" };

	const endMarker = `impeccable-carbonize-end ${id}`;
	const endTextStart = source.indexOf(endMarker, markerStart);
	if (endTextStart < 0) return { ok: false, code: "NO_MARKERS" };
	const end = markerLineEnd(source, endTextStart + endMarker.length);

	const variants = findAdjacentVariants(source, end);
	const chosen = variants.find((variant) => variant.id === String(chosenVariantId));
	if (!chosen) {
		return { ok: false, code: "NO_VARIANT", detail: String(chosenVariantId) };
	}

	const style = extractCarbonizeStyle(source, markerStart, end, paramValues);
	const chosenSource = bakeMarkup(source.slice(chosen.innerStart, chosen.innerEnd), paramValues);
	const replacement = [style, chosenSource].filter((part): part is string => part !== null).join("\n");
	const replacementEnd = variants.reduce((last, variant) => Math.max(last, variant.end), chosen.end);
	return { ok: true, source: source.slice(0, markerStart) + replacement + source.slice(replacementEnd) };
}

function hashContent(source: string): string {
	return createHash("sha256").update(source).digest("hex");
}

function findAnyMarker(source: string, marker: string): number {
	return source.indexOf(marker);
}

function findMarkerStart(source: string, markerPosition: number): number {
	const lineStart = source.lastIndexOf("\n", markerPosition) + 1;
	const htmlStart = source.lastIndexOf("<!--", markerPosition);
	if (htmlStart >= lineStart) return htmlStart;
	const jsxStart = source.lastIndexOf("{/*", markerPosition);
	if (jsxStart >= lineStart) return jsxStart;
	return markerPosition;
}

function readMarkerId(source: string, markerPosition: number, marker: string): string | null {
	const match = source.slice(markerPosition).match(new RegExp(`${escapeRegExp(marker)}\\s+([^\\s*]+)`));
	return match?.[1] ?? null;
}

function markerLineEnd(source: string, position: number): number {
	const commentEnd = source.indexOf("-->", position);
	const jsxCommentEnd = source.indexOf("*/}", position);
	const newline = source.indexOf("\n", position);
	const candidates = [commentEnd < 0 ? source.length : commentEnd + 3, jsxCommentEnd < 0 ? source.length : jsxCommentEnd + 3];
	const commentEndPosition = Math.min(...candidates);
	return commentEndPosition < source.length && (newline < 0 || commentEndPosition <= newline)
		? commentEndPosition
		: position;
}

function findAdjacentVariants(source: string, from: number): ElementBlock[] {
	const result: ElementBlock[] = [];
	const opener = /<([A-Za-z][A-Za-z0-9:_-]*)\b[^>]*\bdata-impeccable-variant\s*=\s*(?:"([^"]+)"|'([^']+)'|\{\s*["']([^"']+)["']\s*\})[^>]*>/g;
	let cursor = from;
	while (true) {
		opener.lastIndex = cursor;
		const match = opener.exec(source);
		if (!match) break;
		if (source.slice(cursor, match.index).trim() !== "") break;
		const block = matchElement(source, match.index, match[0], match[1], match[2] ?? match[3] ?? match[4] ?? "");
		if (!block) break;
		result.push(block);
		cursor = block.end;
	}
	return result;
}

function matchElement(source: string, start: number, opening: string, tagName: string, id: string): ElementBlock | null {
	const innerStart = start + opening.length;
	if (/\/\s*>$/.test(opening)) {
		return { start, end: innerStart, innerStart, innerEnd: innerStart, id };
	}
	const tags = new RegExp(`<\\/?${escapeRegExp(tagName)}\\b[^>]*>`, "g");
	tags.lastIndex = innerStart;
	let depth = 1;
	let match: RegExpExecArray | null;
	while ((match = tags.exec(source))) {
		if (match[0].startsWith("</")) {
			depth -= 1;
			if (depth === 0) {
				return { start, end: match.index + match[0].length, innerStart, innerEnd: match.index, id };
			}
		} else if (!/\/\s*>$/.test(match[0])) {
			depth += 1;
		}
	}
	return null;
}

function extractCarbonizeStyle(
	source: string,
	start: number,
	end: number,
	paramValues: Record<string, string | number>,
): string | null {
	const styleRe = /<style\b[^>]*\bdata-impeccable-css\s*=\s*("([^"]+)"|'([^']+)')[^>]*>/g;
	styleRe.lastIndex = start;
	const match = styleRe.exec(source);
	if (!match || match.index >= end) return null;
	const closeStart = source.indexOf("</style", match.index + match[0].length);
	if (closeStart < 0 || closeStart > end) return null;
	const closeEnd = source.indexOf(">", closeStart);
	if (closeEnd < 0 || closeEnd > end) return null;

	const opening = match[0].replace(/\s+data-impeccable-css\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\})/i, "");
	let body = source.slice(match.index + match[0].length, closeStart);
	const jsxWrapped = /^\s*\{`/.test(body) && /`}\s*$/.test(body);
	if (jsxWrapped) {
		body = body.replace(/^\s*\{`/, "").replace(/`}\s*$/, "");
	}
	body = bakeCss(body, paramValues);
	if (jsxWrapped) body = "{`" + body + "`}";
	return `${opening}${body}${source.slice(closeStart, closeEnd + 1)}`;
}

function bakeMarkup(markup: string, values: Record<string, string | number>): string {
	let output = replaceParamValues(markup, values);
	output = output.replace(/\s+data-impeccable-[A-Za-z0-9:_-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\}))?/gi, "");
	output = output.replace(/\s+data-p-[A-Za-z0-9_-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^{}]*\}))?/gi, "");
	return replaceRemainingParamVars(output);
}

function replaceParamValues(text: string, values: Record<string, string | number>): string {
	let output = text;
	for (const [id, value] of Object.entries(values)) {
		const literal = String(value);
		output = substituteParamVar(output, id, literal);
		const escaped = escapeRegExp(id);
		// Use a function replacer so `$`-sequences in the value (e.g. `$&`, `$$`)
		// are treated as literal text, not replacement patterns.
		output = output.replace(new RegExp(`\\{\\{\\s*(?:p[-_])?${escaped}\\s*\\}\\}`, "g"), () => literal);
		output = output.replace(new RegExp(`__p-${escaped}__`, "g"), () => literal);
	}
	return output;
}

function substituteParamVar(text: string, id: string, value: string): string {
	const needle = `var(--p-${id}`;
	let output = "";
	let cursor = 0;
	while (cursor < text.length) {
		const found = text.indexOf(needle, cursor);
		if (found < 0) return output + text.slice(cursor);
		const after = found + needle.length;
		if (after < text.length && text[after] !== ")" && text[after] !== ",") {
			output += text.slice(cursor, after);
			cursor = after;
			continue;
		}
		let index = after;
		let depth = 1;
		while (index < text.length && depth > 0) {
			if (text[index] === "(") depth += 1;
			else if (text[index] === ")") depth -= 1;
			index += 1;
		}
		output += text.slice(cursor, found) + value;
		cursor = index;
	}
	return output;
}

function bakeCss(css: string, values: Record<string, string | number>): string {
	let output = transformCss(css, values);
	output = replaceParamValues(output, values);
	output = output.replace(/(^|[;{])\s*--impeccable-variant-ready\s*:[^;{}]+;?/g, "$1");
	output = output.replace(/\[data-p-[A-Za-z0-9_-]+(?:=(?:"[^"]*"|'[^']*'))?\]/gi, "");
	output = output.replace(/\bdata-p-[A-Za-z0-9_-]+\b/gi, "");
	output = replaceRemainingParamVars(output);
	return output.replace(/--impeccable-variant-ready\s*:[^;{}]+;?/g, "");
}

function replaceRemainingParamVars(text: string): string {
	let output = "";
	let cursor = 0;
	while (cursor < text.length) {
		const start = text.indexOf("var(--p-", cursor);
		if (start < 0) return output + text.slice(cursor);
		let index = start + "var(".length;
		let depth = 1;
		while (index < text.length && depth > 0) {
			if (text[index] === "(") depth += 1;
			else if (text[index] === ")") depth -= 1;
			index += 1;
		}
		if (depth > 0) return output + text.slice(cursor);
		const inner = text.slice(start + "var(".length, index - 1).replace(/^\s*--p-[A-Za-z0-9_-]+\s*,\s*/, "").trim();
		output += text.slice(cursor, start) + (inner || "initial");
		cursor = index;
	}
	return output;
}

function transformCss(css: string, values: Record<string, string | number>): string {
	return parseCssBlock(css, values, 0).output;
}

type ParsedCssBlock = { output: string; index: number };

function parseCssBlock(css: string, values: Record<string, string | number>, start: number): ParsedCssBlock {
	let output = "";
	let cursor = start;
	while (cursor < css.length) {
		const delimiter = findCssDelimiter(css, cursor);
		if (!delimiter) return { output: output + css.slice(cursor), index: css.length };
		if (delimiter.kind === "close") return { output: output + css.slice(cursor, delimiter.index), index: delimiter.index };

		const prelude = css.slice(cursor, delimiter.index).trim();
		const body = parseCssBlock(css, values, delimiter.index + 1);
		if (prelude.startsWith("@scope")) {
			output += body.output;
		} else if (prelude.startsWith("@")) {
			output += `${prelude}{${body.output}}`;
		} else {
			const selectors = splitSelectors(prelude)
				.map((selector) => bakeSelector(selector, values))
				.filter((selector): selector is string => selector !== null);
			if (selectors.length > 0) output += `${selectors.join(", ")}{${body.output}}`;
		}
		cursor = body.index < css.length ? body.index + 1 : body.index;
	}
	return { output, index: cursor };
}

function findCssDelimiter(css: string, from: number): { kind: "open" | "close"; index: number } | null {
	let quote = "";
	for (let index = from; index < css.length; index += 1) {
		const char = css[index];
		if (quote) {
			if (char === quote && css[index - 1] !== "\\") quote = "";
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "{") return { kind: "open", index };
		if (char === "}") return { kind: "close", index };
	}
	return null;
}

function splitSelectors(prelude: string): string[] {
	const selectors: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < prelude.length; index += 1) {
		if (prelude[index] === "(") depth += 1;
		else if (prelude[index] === ")") depth -= 1;
		else if (prelude[index] === "," && depth === 0) {
			selectors.push(prelude.slice(start, index));
			start = index + 1;
		}
	}
	selectors.push(prelude.slice(start));
	return selectors;
}

function bakeSelector(selector: string, values: Record<string, string | number>): string | null {
	let output = selector;
	const params = /\[data-p-([A-Za-z0-9_-]+)(?:=("([^"]*)"|'([^']*)'))?\]/gi;
	let match: RegExpExecArray | null;
	while ((match = params.exec(selector))) {
		const id = match[1];
		const expected = match[3] ?? match[4];
		if (expected !== undefined && Object.prototype.hasOwnProperty.call(values, id) && String(values[id]) !== expected) return null;
		output = output.replace(match[0], "");
	}
	output = output.replace(/\[data-impeccable-[A-Za-z0-9:_-]+(?:=(?:"[^"]*"|'[^']*'))?\]/gi, "");
	output = output.replace(/:global\(\s*\)/g, "").replace(/\s+/g, " ").trim();
	return output || null;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
