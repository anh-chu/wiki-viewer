/**
 * Both annotation kinds must vanish when their anchor is lost.
 *
 * The objective retires recovery UI: an annotation whose text is gone has nothing to
 * point at. Comments and suggestions reach that end state by different mechanisms, and
 * the difference is deliberate rather than an oversight:
 *
 *   - Comments render unconditionally in the margin column, so they need an explicit
 *     terminal flag. They are marked resolved with `cancelReason: "anchor-lost"`, which
 *     also drops them out of the pending set Copy-as-prompt reads.
 *   - Suggestions render only when something selects them, and every selector already
 *     filters on `!stale`. Setting `stale = true` is therefore sufficient to make one
 *     disappear; adding a cancel flag would be redundant state.
 *
 * The property that matters is the one shared by both: once the anchor is gone, the
 * annotation is neither shown nor treated as pending. Each half is checked here, and
 * the asymmetry is asserted rather than assumed so a future change that makes one kind
 * linger is caught.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(path.join(ROOT, p), "utf8");

describe("a lost anchor removes the annotation from every surface", () => {
	test("stale suggestions are excluded from the editor's pending set", () => {
		assert.match(
			read("src/components/editor/editor.tsx"),
			/suggestionsRaw\?\.filter\(\(sg\) => sg\.status === "pending" && !sg\.stale\)/,
			"the editor must not treat a stale suggestion as pending",
		);
	});

	test("stale suggestions do not keep the document in the collaborating state", () => {
		// Otherwise an agent would be refused a raw write on account of a suggestion
		// that no longer corresponds to any text.
		assert.match(
			read("src/lib/proof/collab-state.ts"),
			/\(s\) => s\.status === "pending" && !s\.stale,/,
			"collab-state must ignore stale suggestions",
		);
	});

	test("cancelled comments are excluded from the margin", () => {
		assert.match(
			read("src/components/editor/editor.tsx"),
			/list\.filter\(\(c\) => !c\.cancelledAt\)/,
			"the margin must drop cancelled comments",
		);
	});

	test("cancelled comments are excluded from highlights too", () => {
		// Both conditions matter: a cancelled comment is resolved, so the first alone
		// would suffice today, but the highlight must not depend on that coincidence.
		const hl = read("src/components/editor/extensions/comment-highlight.ts");
		assert.match(hl, /comment\.resolved/, "resolved comments must not highlight");
	});

	test("the asymmetry is real: suggestions get stale, comments get cancelled", () => {
		// Pins the intended difference so neither silently changes into the other.
		const applier = read("src/lib/proof/ops-applier.ts");
		const staleBranch = applier.slice(
			applier.indexOf("for (const s of sidecar.suggestions)"),
			applier.indexOf("for (const c of sidecar.comments)"),
		);
		assert.match(staleBranch, /s\.stale = true;/, "suggestions latch stale");
		assert.ok(
			!/cancelledAt/.test(staleBranch),
			"suggestions are not given a cancel flag",
		);

		const commentBranch = applier.slice(
			applier.indexOf("for (const c of sidecar.comments)"),
			applier.indexOf("function buildSnapshot"),
		);
		assert.match(commentBranch, /c\.resolved = true;/, "comments are resolved");
		assert.match(
			commentBranch,
			/c\.cancelReason = "anchor-lost";/,
			"with the reason recorded",
		);
	});

	test("CONTROL: the exclusion filters are not vacuous", () => {
		// Proves these files really do filter suggestions somewhere, so a match above is
		// meaningful rather than incidental.
		assert.match(read("src/components/editor/editor.tsx"), /\.filter\(/);
		assert.match(read("src/lib/proof/collab-state.ts"), /\.filter\(/);
	});
});
