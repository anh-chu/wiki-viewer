/**
 * FTS5 user-query sanitizer.
 *
 * Converts raw user input into a safe FTS5 MATCH expression.
 * Strategy: whitelist alphanumerics + hyphen + underscore, double-quote
 * every token, optionally preserve trailing * for prefix search.
 * This neutralizes ALL FTS5 operators (AND, OR, NOT, NEAR, (, ), ^)
 * because quoted tokens are treated as literal phrases, not operators.
 */

/** Match Unicode letters, numbers, hyphen, underscore, optionally followed by *. */
const TOKEN_RE = /[\p{L}\p{N}_-]+\*?/gu;

/** Max tokens accepted per query (prevents degenerate query bombs). */
const MAX_TOKENS = 16;

/**
 * Returns a sanitized FTS5 query string, or "" if the input is empty
 * or contains no valid tokens. An empty return means the caller should
 * short-circuit and return no results without hitting FTS5.
 */
export function sanitizeFtsQuery(raw: string): string {
	const tokens = (raw.match(TOKEN_RE) ?? []).slice(0, MAX_TOKENS);
	if (tokens.length === 0) return "";
	return tokens
		.map((t) => {
			const star = t.endsWith("*");
			const core = star ? t.slice(0, -1) : t;
			if (!core) return null; // trailing * with empty body
			const escaped = core.replace(/"/g, '""');
			return `"${escaped}"` + (star ? "*" : "");
		})
		.filter(Boolean)
		.join(" ");
}
