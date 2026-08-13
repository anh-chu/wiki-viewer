export type ScratchTextExt = string;

/**
 * Guess a programming-language extension from a code snippet using cheap,
 * high-signal syntax markers. Returns null when no language is confidently
 * detected (caller falls back to plain text). Order is deliberate: the most
 * distinctive markers are checked first.
 */
export function detectCodeExt(text: string): string | null {
	const s = text.slice(0, 8192);

	// Shebang wins outright.
	const shebang = s.match(/^#!.*\b(bash|sh|zsh|python[0-9.]*|node|ruby|php)\b/);
	if (shebang) {
		const tool = shebang[1];
		if (/^python/.test(tool)) return "py";
		if (tool === "node") return "js";
		if (tool === "ruby") return "rb";
		if (tool === "php") return "php";
		return "sh";
	}

	const tests: Array<[RegExp, string]> = [
		// JSON: whole thing parses.
		[/^\s*[[{][\s\S]*[\]}]\s*$/, "__json__"],
		// TypeScript-specific: type annotations, interfaces, generics with types.
		[/\b(interface|type)\s+[A-Za-z_$][\w$]*\s*[=<{]/, "ts"],
		[/:\s*(string|number|boolean|any|unknown|void)\b/, "ts"],
		// Python.
		[/^\s*def\s+\w+\s*\(.*\)\s*:/m, "py"],
		[/^\s*(import|from)\s+\w+.*$/m, "py"],
		[/^\s*print\s*\(/m, "py"],
		// Rust.
		[/\bfn\s+\w+\s*\(/, "rs"],
		[/\blet\s+mut\s+\w+/, "rs"],
		[/\bprintln!\s*\(/, "rs"],
		// Go.
		[/\bpackage\s+\w+/, "go"],
		[/\bfunc\s+\w+\s*\(/, "go"],
		[/\bfmt\.[A-Z]\w+\(/, "go"],
		// Java / C-family.
		[/\b(public|private|protected)\s+(static\s+)?(class|void|int|String)\b/, "java"],
		[/#include\s*[<"]/, "c"],
		// Ruby.
		[/^\s*def\s+\w+[\s\S]*?\bend\b/m, "rb"],
		[/\bputs\s+/, "rb"],
		// PHP.
		[/<\?php\b/, "php"],
		// Shell.
		[/^\s*(echo|export|if\s+\[)\b/m, "sh"],
		// SQL.
		[/\b(SELECT|INSERT|UPDATE|DELETE)\b[\s\S]*\bFROM\b|\bCREATE\s+TABLE\b/i, "sql"],
		// CSS.
		[/[.#]?[\w-]+\s*\{[^}]*:[^}]*;[^}]*\}/, "css"],
		// YAML.
		[/^[\w-]+:\s*(\n\s+[\w-]+:|\S)/m, "yaml"],
		// JavaScript (generic, checked late so TS wins first).
		[/\b(const|let|var)\s+\w+\s*=|=>|\bfunction\s*\*?\s*\(/, "js"],
	];

	for (const [re, ext] of tests) {
		if (re.test(s)) {
			if (ext === "__json__") {
				try {
					JSON.parse(text);
					return "json";
				} catch {
					continue;
				}
			}
			return ext;
		}
	}
	return null;
}

/**
 * Sniff pasted/typed text and pick the best scratch extension.
 *
 * Order matters: HTML is checked first (its angle-bracket markup is
 * unambiguous), then markdown signals, else plain text. This is a heuristic
 * for choosing a viewer, not a validator.
 */
export function detectScratchExt(text: string): ScratchTextExt {
	const sample = text.slice(0, 4096);
	const trimmed = sample.trimStart();
	const lower = trimmed.toLowerCase();

	// Clear HTML document / fragment markers.
	if (
		lower.startsWith("<!doctype html") ||
		lower.startsWith("<html") ||
		lower.startsWith("<head") ||
		lower.startsWith("<body")
	) {
		return "html";
	}
	// Fragment: starts with a tag and has several tags overall.
	if (/^<[a-z][\w-]*[\s>/]/i.test(trimmed)) {
		const tagCount = (sample.match(/<[a-z][\w-]*[\s>/]/gi) ?? []).length;
		if (tagCount >= 2) return "html";
	}

	// Markdown signals.
	const mdSignals = [
		/^#{1,6}\s+\S/m, // heading
		/^\s*[-*+]\s+\S/m, // bullet list
		/^\s*\d+\.\s+\S/m, // ordered list
		/^\s*>\s+\S/m, // blockquote
		/```/, // fenced code
		/\[[^\]]+\]\([^)]+\)/, // link
		/(^|\s)(\*\*|__)\S/, // bold
		/^\|.+\|\s*$/m, // table row
	];
	if (mdSignals.some((re) => re.test(sample))) return "md";

	// Try to classify as a known programming language before giving up on txt.
	const code = detectCodeExt(text);
	if (code) return code;

	return "txt";
}
