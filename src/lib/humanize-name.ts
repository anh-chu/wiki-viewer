// Display-only: turn a code-cased file name into a human-readable label.
// Never mutates the real file name; callers keep the original in a tooltip.
// All-caps tokens stay whole (API, README), so acronyms survive.
export function humanizeName(name: string): string {
	const dot = name.lastIndexOf(".");
	const hasExt = dot > 0 && dot < name.length - 1;
	const stem = hasExt ? name.slice(0, dot) : name;
	const ext = hasExt ? name.slice(dot) : "";

	const words = stem
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camel: fooBar -> foo Bar
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // acronym: HTMLDoc -> HTML Doc
		.split(/[\s_-]+/)
		.filter(Boolean)
		.map((t) => (/^[A-Z0-9]+$/.test(t) ? t : t[0].toUpperCase() + t.slice(1)));

	return words.length ? words.join(" ") + ext : name;
}
