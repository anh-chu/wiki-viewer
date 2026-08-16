export interface HtmlPickTarget {
	selector: string;
	elementPath: string;
}

export function deriveHtmlTargetKey(pick: HtmlPickTarget): string {
	return `${pick.selector}\u0000${pick.elementPath}`;
}
