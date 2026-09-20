/**
 * A direct save must reconcile block refs and mark orphaned comments lost.
 *
 * FOUND LIVE, not from a test. The margin column was showing four comment cards while
 * only two comments had a highlight anywhere in the document: the other two pointed at
 * refs that no longer existed. The fix is that such a comment is marked LOST: it keeps
 * its card and paints no highlight, so the margin stops claiming a place in the text
 * that the comment no longer has. (It was briefly cancelled outright instead, which
 * also removed the mismatch but by deleting what the user wrote.)
 *
 * ROOT CAUSE. `PUT /api/wiki/content` (the editor's own save) writes the file and bumps
 * the sidecar revision and fingerprint, but never recomputed `refMap`. The cancellation
 * logic lives in `markOrphanedRefsStale`, which only ran on the ops-applier path. So a
 * plain save left `refMap` describing the OLD document while the file on disk was the
 * new one, and nothing ever noticed.
 *
 * The sidecar for the user's file made it unambiguous: it listed five comments and a
 * `refMap` containing a single ref, with no comment cancelled and `cancelReason` unset.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { assignRefs } from "@/lib/proof/block-refs";
import { parseBlocks } from "@/lib/proof/blocks";
import { reconcileRefsAndCancelOrphans } from "@/lib/proof/ops-applier";
import type { Sidecar } from "@/lib/proof/types";

const ROUTE = readFileSync(
	path.join(process.cwd(), "src/app/api/wiki/content/route.ts"),
	"utf8",
);


/** Strip line and block comments so an assertion is about code, not about text. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** True when `name` appears as a live (non-commented) call in `source`. */
function hasLiveCall(source: string, name: string): boolean {
	return new RegExp(`\\b${name}\\s*\\(`).test(stripComments(source));
}

/** The user's document, exactly as it was when the defect was observed. */
const CONTENT =
	"1. Non-product surveys\n\n2. Reactions in app\n\n   1. like/dislike\n\n   2. Input - what's real?\n\n3. Collect info:\n\n   1. Majors?\n\n   2. School\n\n   3. Job\n\n4. LLM to test\n";

function sidecarWith(refs: string[]): Sidecar {
	return {
		version: 1,
		path: "test.md",
		revision: 32,
		createdAt: "2026-09-18T00:00:00.000Z",
		updatedAt: "2026-09-18T00:00:00.000Z",
		fingerprint: "sha256:stale",
		refMap: {},
		blocks: [],
		comments: refs.map((ref, i) => ({
			id: `c${i}`,
			ref,
			text: `comment ${i}`,
			resolved: false,
			createdAt: "2026-09-18T00:00:00.000Z",
			author: { id: "human", name: "human" },
			turns: [],
		})),
		suggestions: [],
		events: [],
	} as unknown as Sidecar;
}

describe("a direct save cancels comments whose anchor it removed", () => {
	test("the document really does mint only one ref", () => {
		// Establishes the premise: three of the four stored refs are genuinely dead.
		// Without this the test could pass against a document that still contains them.
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);
		assert.equal(refs.length, 1, `expected one ref, got ${refs.join(",")}`);
		assert.equal(refs[0], "b483fa8");
	});

	test("the dead-ref comments are cancelled, and the live one is untouched", () => {
		const sc = sidecarWith(["b55b0d0", "bbf2566", "b2a7a89", "b483fa8"]);
		reconcileRefsAndCancelOrphans(sc, CONTENT);

		const byId = Object.fromEntries(sc.comments.map((c) => [c.id, c]));
		for (const id of ["c0", "c1", "c2"]) {
			assert.equal(byId[id].anchorStatus, "lost", `${id} must be marked lost`);
			assert.notEqual(byId[id].resolved, true, `${id} is kept, not resolved`);
			assert.equal(byId[id].cancelledAt, undefined, `${id} is never cancelled`);
		}
		assert.equal(byId.c3.anchorStatus, undefined, "the anchored comment is not marked lost");
		assert.equal(byId.c3.resolved, false, "and it stays open");
	});

	test("refMap is rewritten to match the content, not left describing the old one", () => {
		const sc = sidecarWith(["b55b0d0"]);
		reconcileRefsAndCancelOrphans(sc, CONTENT);
		assert.deepEqual(Object.keys(sc.refMap), ["b483fa8"]);
	});

	test("the save route calls it", () => {
		// The fix is only real if the route that saves the file uses it.
		assert.ok(
			hasLiveCall(ROUTE, "reconcileRefsAndCancelOrphans"),
			"the save route must reconcile refs after writing",
		);
	});

	test("CONTROL: a commented-out call does not count", () => {
		// This guard exists because the first version of the test above used an
		// unanchored regex, which matched the call inside a comment: commenting the
		// real call out left the suite green. Verified by perturbing the route, which
		// passed 5/5 with the call disabled. Stripping comments is what makes the
		// assertion about executed code rather than about text.
		assert.ok(
			!hasLiveCall(
				"\t\t// reconcileRefsAndCancelOrphans(sc, content);\n",
				"reconcileRefsAndCancelOrphans",
			),
			"a commented-out call must not satisfy the guard",
		);
		assert.ok(
			hasLiveCall("\t\treconcileRefsAndCancelOrphans(sc, content);\n", "reconcileRefsAndCancelOrphans"),
			"and a real one must",
		);
	});

	test("CONTROL: reconciliation happens after the content is written", () => {
		// Reconciling against the wrong content would cancel healthy comments.
		const code = stripComments(ROUTE);
		const writeAt = code.indexOf("await writeFile(filePath, content");
		const reconcileAt = code.indexOf("reconcileRefsAndCancelOrphans(sc, content);");
		assert.ok(writeAt > 0 && reconcileAt > 0, "both steps must be present as live code");
		assert.ok(
			writeAt < reconcileAt,
			"the file must be written before refs are recomputed from its content",
		);
	});
});
