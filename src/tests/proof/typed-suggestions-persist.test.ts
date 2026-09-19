/**
 * Typed tracked edits must become durable sidecar suggestions.
 *
 * THE DEFECT THIS FILE EXISTS FOR
 * -------------------------------
 * Suggesting mode stamped ProseMirror marks, and the serialization strip removed
 * them on save. So typed text landed in the file as a permanent edit with no
 * suggestion record at all: pending on screen, already applied on disk, gone on
 * reload. The `onTrackedEdit` hook existed for this and was never passed.
 *
 * WHY THE FIRST VERSION OF THIS TEST WAS WORTHLESS
 * ------------------------------------------------
 * That fix landed with a guard made of regexes over source text: assert the file
 * mentions `onTrackedEdit:`, contains `COALESCE_MS`, and has a variable named
 * `continuing`. It passed 8/8 while the feature was still broken, because the
 * defect was in the state machine, not in the spelling:
 *
 *   - `suggestionId` was never bound to the run after `suggestion.add` returned,
 *     so the run could never be extended;
 *   - therefore coalescing never happened, every keystroke created a new
 *     suggestion, and the text was posted as `markdown: ""`;
 *   - nothing durable ever held the proposal.
 *
 * The code satisfied every assertion. A reviewer found it. So the decision logic
 * now lives in `tracked-edit-runs` as pure functions and is driven directly
 * below, with no source-text matching anywhere in this file.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	COALESCE_MS,
	createOp,
	decideEdit,
	editOp,
	type EditRun,
	type RunDecision,
	newRun,
	runKey,
	willExtend,
} from "@/lib/proof/tracked-edit-runs";

const base = { path: "notes.md", ref: "babc123", kind: "insert" as const };

/** A run as it exists once its `suggestion.add` response has supplied an id. */
function boundRun(overrides: Partial<EditRun> = {}): EditRun {
	return {
		key: runKey(base.path, base.ref, base.kind),
		path: base.path,
		ref: base.ref,
		suggestionId: "s0a1b",
		text: "he",
		kind: base.kind,
		...overrides,
	};
}

/** Narrow a decision to its "start" arm for the cases that expect one. */
function startOf(decision: ReturnType<typeof decideEdit>) {
	assert.equal(decision.action, "start", "expected this edit to start a run");
	return newRun(decision as Extract<typeof decision, { action: "start" }>);
}

describe("a typed edit either extends its run or starts one", () => {
	test("a run with a bound id is extended, and its text accumulates", () => {
		// The behaviour that was impossible before the fix.
		const decision = decideEdit(boundRun(), { ...base, text: "llo" });
		assert.equal(decision.action, "extend");
		assert.equal(decision.action === "extend" && decision.text, "hello");
	});

	test("the FIRST edit starts a run, because no record exists yet", () => {
		const run = startOf(decideEdit(null, { ...base, text: "h" }));
		assert.equal(run.suggestionId, null, "the id arrives with the create response");
		assert.equal(run.text, "h");
	});

	test("an unbound run does NOT extend — the regression that hid here", () => {
		// This is the exact condition the old code got wrong. A run whose create
		// response has not landed has no record to extend, so accumulating text into
		// it would build a proposal nothing durable holds.
		const unbound = boundRun({ suggestionId: null });
		assert.equal(decideEdit(unbound, { ...base, text: "llo" }).action, "start");
		assert.equal(willExtend(unbound, base), false);
	});

	test("changing block starts a new suggestion", () => {
		const decision = decideEdit(boundRun(), { ...base, ref: "bother1", text: "x" });
		assert.equal(decision.action, "start", "a run never spans two blocks");
	});

	test("changing kind starts a new suggestion", () => {
		// Typing then deleting in the same block are different proposals.
		const decision = decideEdit(boundRun(), { ...base, kind: "delete", text: "x" });
		assert.equal(decision.action, "start");
	});

	test("changing document starts a new suggestion", () => {
		const decision = decideEdit(boundRun(), { ...base, path: "other.md", text: "x" });
		assert.equal(decision.action, "start");
	});

	test("CONTROL: a bound run with the same key IS extendable", () => {
		// Without this, the three "starts a new suggestion" cases above would pass
		// even if the function always returned `start`.
		assert.equal(willExtend(boundRun(), base), true);
		assert.equal(decideEdit(boundRun(), { ...base, text: "!" }).action, "extend");
	});
});

describe("the proposal text is what gets persisted", () => {
	test("the create op carries the typed text, not an empty string", () => {
		// Posting `markdown: ""` is precisely why a reload lost the proposal.
		const run = startOf(decideEdit(null, { ...base, text: "hello" }));
		const op = createOp(run) as { markdown?: string; type: string; ref?: string };
		assert.equal(op.markdown, "hello", "the record must hold the proposed text");
		assert.equal(op.type, "suggestion.add");
		assert.equal(op.ref, base.ref);
	});

	test("the edit op carries the full accumulated text", () => {
		const op = editOp(boundRun({ text: "hello" })) as {
			markdown?: string;
			suggestionId?: string;
		};
		assert.equal(op.markdown, "hello");
		assert.equal(op.suggestionId, "s0a1b", "and targets the run's own record");
	});

	test("CONTROL: a create op for a different run differs", () => {
		const a = createOp(boundRun({ text: "one" }));
		const b = createOp(boundRun({ text: "two" }));
		assert.notDeepEqual(a, b, "the op is genuinely derived from the run");
	});
});

describe("a typing burst becomes one suggestion, not one per keystroke", () => {
	test("five keystrokes produce one create and four edits", () => {
		// Drives the whole sequence the way `onTrackedEdit` does: per transaction.
		const creates: unknown[] = [];
		const edits: unknown[] = [];
		let run: EditRun | null = null;

		for (const ch of ["h", "e", "l", "l", "o"]) {
			const decision: RunDecision = decideEdit(run, { ...base, text: ch });
			if (decision.action === "start") {
				run = newRun(decision);
				creates.push(createOp(run));
				// The create response supplies the id; without this the next keystroke
				// would start yet another suggestion.
				run = { ...run, suggestionId: "s0a1b" };
			} else {
				run = { ...decision.run, text: decision.text };
				edits.push(editOp(run));
			}
		}

		assert.equal(creates.length, 1, "one card in the margin, not five");
		assert.equal(edits.length, 4);
		assert.equal(run?.text, "hello", "and the final text is the whole word");
		const last = edits.at(-1) as { markdown?: string };
		assert.equal(last.markdown, "hello", "the sidecar ends up holding the full text");
	});

	test("an unbound run litters the margin — establishes the premise", () => {
		// The counterfactual, kept so the fix's value is visible rather than asserted.
		// If the create response never binds an id, every keystroke starts a run.
		let run: EditRun | null = null;
		let creates = 0;
		for (const ch of ["h", "e", "l", "l", "o"]) {
			const decision: RunDecision = decideEdit(run, { ...base, text: ch });
			if (decision.action === "start") {
				creates += 1;
				run = newRun(decision); // note: id never bound
			}
		}
		assert.equal(creates, 5, "five cards, and no durable text");
	});

	test("the coalescing window is a real, positive duration", () => {
		assert.ok(COALESCE_MS > 0, "a zero window would never merge anything");
	});
});