/**
 * Safe renderer for FTS5 snippet() output.
 * Parses <mark>...</mark> tags from the snippet string without using
 * dangerouslySetInnerHTML. Any other HTML in source files is rendered as text.
 */

interface Part {
	text: string;
	mark: boolean;
}

function parseSnippet(html: string): Part[] {
	const parts: Part[] = [];
	const re = /<mark>([\s\S]*?)<\/mark>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		if (m.index > last) {
			parts.push({ text: html.slice(last, m.index), mark: false });
		}
		parts.push({ text: m[1] ?? "", mark: true });
		last = m.index + m[0].length;
	}
	if (last < html.length) {
		parts.push({ text: html.slice(last), mark: false });
	}
	return parts;
}

export function SnippetText({ html }: { html: string }) {
	const parts = parseSnippet(html);
	return (
		<>
			{parts.map((p, i) =>
				p.mark ? (
					<mark
						key={i}
						className="bg-yellow-200 dark:bg-yellow-700 rounded-[2px] px-[1px]"
					>
						{p.text}
					</mark>
				) : (
					<span key={i}>{p.text}</span>
				),
			)}
		</>
	);
}
