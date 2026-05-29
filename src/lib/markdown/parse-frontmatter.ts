/**
 * Tiny client-safe frontmatter parser for wiki YAML.
 * Handles the subset we use: scalars, inline arrays, and block arrays.
 * Not a full YAML parser. For complex structures, fall back to server.
 */

export interface ParsedFrontmatter {
	data: Record<string, unknown>;
	body: string;
}

const BLOCK_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(raw: string): unknown {
	const v = raw.trim();
	if (v === "") return "";
	if (v === "true") return true;
	if (v === "false") return false;
	if (v === "null" || v === "~") return null;
	if (/^-?\d+$/.test(v)) return Number(v);
	if (/^-?\d*\.\d+$/.test(v)) return Number(v);
	// Quoted string
	if (
		(v.startsWith('"') && v.endsWith('"')) ||
		(v.startsWith("'") && v.endsWith("'"))
	) {
		return v.slice(1, -1);
	}
	// Inline array: [a, b, c]
	if (v.startsWith("[") && v.endsWith("]")) {
		const inner = v.slice(1, -1).trim();
		if (inner === "") return [];
		return inner.split(",").map((s) => parseScalar(s));
	}
	return v;
}

export function parseFrontmatter(text: string): ParsedFrontmatter {
	const match = BLOCK_RE.exec(text);
	if (!match) return { data: {}, body: text };

	const block = match[1];
	const body = text.slice(match[0].length);
	const data: Record<string, unknown> = {};

	const lines = block.split(/\r?\n/);
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (!line || /^\s*#/.test(line)) {
			i += 1;
			continue;
		}
		const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
		if (!m) {
			i += 1;
			continue;
		}
		const key = m[1];
		const rest = m[2];
		if (rest.trim() === "") {
			// Possibly a block array on following indented lines
			const items: unknown[] = [];
			let j = i + 1;
			while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
				const itemMatch = /^\s+-\s+(.*)$/.exec(lines[j]);
				if (itemMatch) items.push(parseScalar(itemMatch[1]));
				j += 1;
			}
			if (items.length > 0) {
				data[key] = items;
				i = j;
				continue;
			}
			data[key] = "";
			i += 1;
			continue;
		}
		data[key] = parseScalar(rest);
		i += 1;
	}

	return { data, body };
}
