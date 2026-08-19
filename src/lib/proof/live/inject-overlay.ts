/** Configuration for injecting the Impeccable live browser overlay. */
export interface InjectOverlayConfig {
	scriptSrc: string;
	globals: Record<string, unknown>;
}

const INJECTION_MARKER = "impeccable-live-start";
const INJECTION_END_MARKER = "impeccable-live-end";

/**
 * Inject the live overlay prelude and browser bundle into an HTML document.
 *
 * This transform deliberately performs no filesystem or network I/O. It keeps
 * the original document byte-for-byte except for the block inserted before
 * the first closing head tag, then body, or at EOF when neither exists.
 * Anchoring on the first match avoids a `</head>`/`</body>` sequence embedded
 * in a later inline script or string literal being mistaken for the structural
 * document boundary.
 */
export function injectOverlay(html: string, config: InjectOverlayConfig): string {
	if (html.includes(INJECTION_MARKER)) return html;

	const block = buildInjectionBlock(config);
	const anchor = findFirstClosingTag(html, "head") ?? findFirstClosingTag(html, "body");
	if (anchor === null) return html + block;
	return html.slice(0, anchor) + block + html.slice(anchor);
}

function buildInjectionBlock(config: InjectOverlayConfig): string {
	const prelude = Object.entries(config.globals)
		.map(([name, value]) => `window.${name} = ${serializeInlineValue(value)};`)
		.join("\n");
	const scriptSrc = escapeAttribute(config.scriptSrc);
	return [
		`<!-- ${INJECTION_MARKER} -->`,
		`<script data-impeccable-live-prelude>${prelude}</script>`,
		`<script src="${scriptSrc}"></script>`,
		`<!-- ${INJECTION_END_MARKER} -->`,
		"",
	].join("\n");
}

function serializeInlineValue(value: unknown): string {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) return "null";
	// JSON is the value encoding; additionally neutralize the HTML parser's
	// closing-script sequence and JavaScript line separators in inline scripts.
	return serialized
		.replace(/<\//gi, "<\\/")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

function escapeAttribute(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function findFirstClosingTag(html: string, tag: "head" | "body"): number | null {
	const match = new RegExp(`</${tag}\\s*>`, "i").exec(html);
	return match ? match.index : null;
}
