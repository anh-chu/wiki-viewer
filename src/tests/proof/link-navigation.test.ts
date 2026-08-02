import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
	resolveWikiLink,
	type WikiSlugResolver,
} from "../../components/editor/link-navigation.js";

function resolver(
	map: Record<string, "entities" | "concepts" | "comparisons" | "root">,
): WikiSlugResolver {
	const m = new Map(Object.entries(map));
	return {
		has: (slug: string) => m.has(slug),
		getDir: (slug: string) => m.get(slug) ?? null,
	};
}

describe("resolveWikiLink", () => {
	test("resolves sibling relative links", () => {
		const current = "docs/guide.md";
		assert.equal(resolveWikiLink("other.md", current), "docs/other.md");
		assert.equal(resolveWikiLink("./other.md", current), "docs/other.md");
		assert.equal(
			resolveWikiLink("subdir/page.md", current),
			"docs/subdir/page.md",
		);
	});

	test("resolves root links independent of current file", () => {
		assert.equal(
			resolveWikiLink("/overview.md", "docs/guide.md"),
			"overview.md",
		);
		assert.equal(
			resolveWikiLink("/assets/diagram.png", "docs/guide.md"),
			"assets/diagram.png",
		);
		assert.equal(resolveWikiLink("/", "docs/guide.md"), null);
	});

	test("strips heading fragments from path resolution", () => {
		assert.equal(resolveWikiLink("#intro", "docs/guide.md"), null);
		assert.equal(
			resolveWikiLink("other.md#intro", "docs/guide.md"),
			"docs/other.md",
		);
		assert.equal(
			resolveWikiLink("/overview.md#section", "docs/guide.md"),
			"overview.md",
		);
	});

	test("produces deterministic paths for missing targets", () => {
		assert.equal(
			resolveWikiLink("missing.md", "docs/guide.md"),
			"docs/missing.md",
		);
		assert.equal(
			resolveWikiLink("plain-name", "docs/guide.md"),
			"docs/plain-name.md",
		);
		assert.equal(
			resolveWikiLink("/missing/top.md", "docs/guide.md"),
			"missing/top.md",
		);
	});

	test("uses the wiki slug index for bare aliases", () => {
		const r = resolver({ apple: "entities", compare: "comparisons" });
		assert.equal(
			resolveWikiLink("apple", "docs/guide.md", r),
			"entities/apple.md",
		);
		assert.equal(
			resolveWikiLink("compare", "docs/guide.md", r),
			"comparisons/compare.md",
		);
		assert.equal(
			resolveWikiLink("root-slug", "docs/guide.md", resolver({ "root-slug": "root" })),
			"root-slug.md",
		);
	});

	test("explicit file links win over slug aliases", () => {
		const r = resolver({ apple: "entities" });
		assert.equal(
			resolveWikiLink("apple.md", "docs/guide.md", r),
			"docs/apple.md",
		);
	});

	test("rejects external and non-page targets", () => {
		assert.equal(
			resolveWikiLink("https://example.com", "docs/guide.md"),
			null,
		);
		assert.equal(resolveWikiLink("mailto:a@b.com", "docs/guide.md"), null);
		assert.equal(resolveWikiLink("tel:123", "docs/guide.md"), null);
		assert.equal(resolveWikiLink("javascript:x", "docs/guide.md"), null);
		assert.equal(resolveWikiLink("/api/assets/x.png", "docs/guide.md"), null);
		assert.equal(resolveWikiLink("#page:legacy", "docs/guide.md"), null);
	});

	test("rejects paths that escape the workspace root", () => {
		assert.equal(
			resolveWikiLink("../../etc.md", "docs/guide.md"),
			null,
		);
		assert.equal(
			resolveWikiLink("/../outside.md", "docs/guide.md"),
			null,
		);
	});

	test("workspace switches do not leak path prefixes", () => {
		assert.equal(
			resolveWikiLink("/global.md", "ws1/note.md"),
			"global.md",
		);
		assert.equal(
			resolveWikiLink("local.md", "ws1/folder/note.md"),
			"ws1/folder/local.md",
		);
	});

	test("decodes URL-encoded segments", () => {
		assert.equal(
			resolveWikiLink("my%20file.md", "docs/guide.md"),
			"docs/my file.md",
		);
	});
});
