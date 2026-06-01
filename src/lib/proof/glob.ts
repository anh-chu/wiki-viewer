/**
 * Minimal glob matcher.
 *
 * Supported patterns:
 *   **   — any sequence of characters including path separators
 *   *    — any sequence of characters except path separators (/)
 *   ?    — single character that is not /
 *   Literal characters — matched verbatim (case-sensitive)
 *
 * Patterns are anchored to the full string (implicit ^ and $).
 */
export function matchGlob(pattern: string, filePath: string): boolean {
	const regex = globToRegex(pattern);
	return regex.test(filePath);
}

function globToRegex(pattern: string): RegExp {
	let regStr = "^";
	let i = 0;
	while (i < pattern.length) {
		if (pattern[i] === "*" && pattern[i + 1] === "*") {
			// ** — match anything including slashes
			regStr += ".*";
			i += 2;
			// Skip a trailing slash after ** to avoid double-matching: **/foo matches foo too
			if (pattern[i] === "/") {
				regStr += "(?:.+/)?";
				i++;
				// roll back the .* so we match just /**/ properly
				// Actually: keep simple — .* already handles it
			}
		} else if (pattern[i] === "*") {
			// * — match non-slash characters
			regStr += "[^/]*";
			i++;
		} else if (pattern[i] === "?") {
			regStr += "[^/]";
			i++;
		} else {
			// Escape regex special chars
			regStr += escapeRegex(pattern[i]!);
			i++;
		}
	}
	regStr += "$";
	return new RegExp(regStr);
}

function escapeRegex(c: string): string {
	return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}
