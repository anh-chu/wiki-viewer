/**
 * Bounded, NON-RECURSIVE slug listing — the shared source of truth for
 * /api/wiki/slugs and /api/wiki/outlinks.
 *
 * THIS FILE MUST NEVER BECOME RECURSIVE. It reads exactly four well-known
 * directories ONE level deep (root, entities, concepts, comparisons). That
 * bounded contract is the reason the deleted tree-walk cannot come back: a
 * 335k-file workspace already killed the server once with a recursive scan.
 *
 * The readMarkdownSlugsFromDir body is lifted verbatim from
 * src/app/api/wiki/slugs/route.ts (lines 14-27) so bucket output stays
 * byte-identical: files only, name ends ".md" case-insensitively, ".md"
 * stripped, localeCompare sort, ENOENT → [].
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { normalizeSlug } from "@/lib/markdown/wikilink";

// ── Types ────────────────────────────────────────────────────────────────────

export type SlugBuckets = {
	entities: string[];
	concepts: string[];
	comparisons: string[];
	root: string[];
};

export interface SlugListing {
	buckets: SlugBuckets;
	/**
	 * Map from normalised slug to workspace-relative file path.
	 * On duplicate slugs, precedence is root, entities, concepts,
	 * comparisons — first bucket wins.
	 */
	slugMap: Map<string, string>;
}

// ── Internal ─────────────────────────────────────────────────────────────────

async function readMarkdownSlugsFromDir(dirPath: string): Promise<string[]> {
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		return entries
			.filter(
				(entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"),
			)
			.map((entry) => entry.name.slice(0, -3))
			.sort((a, b) => a.localeCompare(b));
	} catch (e: unknown) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT") return [];
		throw e;
	}
}

// ── Public ──────────────────────────────────────────────────────────────────

/**
 * Read exactly four directories ONE level deep.
 *
 * Returns both the buckets (for API compatibility) and a slug→path map for
 * outlink resolution. Precedence on duplicate slugs: root, entities,
 * concepts, comparisons — first bucket to claim a slug wins.
 */
export async function listSlugs(rootDir: string): Promise<SlugListing> {
	const [rootSlugs, entitiesSlugs, conceptsSlugs, comparisonsSlugs] =
		await Promise.all([
			readMarkdownSlugsFromDir(rootDir),
			readMarkdownSlugsFromDir(path.join(rootDir, "entities")),
			readMarkdownSlugsFromDir(path.join(rootDir, "concepts")),
			readMarkdownSlugsFromDir(path.join(rootDir, "comparisons")),
		]);

	const buckets: SlugBuckets = {
		root: rootSlugs,
		entities: entitiesSlugs,
		concepts: conceptsSlugs,
		comparisons: comparisonsSlugs,
	};

	const slugMap = new Map<string, string>();

	// Precedence: root, entities, concepts, comparisons.
	for (const slug of rootSlugs) {
		const norm = normalizeSlug(slug);
		if (!slugMap.has(norm)) slugMap.set(norm, slug + ".md");
	}
	for (const slug of entitiesSlugs) {
		const norm = normalizeSlug(slug);
		if (!slugMap.has(norm)) slugMap.set(norm, "entities/" + slug + ".md");
	}
	for (const slug of conceptsSlugs) {
		const norm = normalizeSlug(slug);
		if (!slugMap.has(norm)) slugMap.set(norm, "concepts/" + slug + ".md");
	}
	for (const slug of comparisonsSlugs) {
		const norm = normalizeSlug(slug);
		if (!slugMap.has(norm)) slugMap.set(norm, "comparisons/" + slug + ".md");
	}

	return { buckets, slugMap };
}
