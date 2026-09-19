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
import { useProofStore } from "@/stores/proof-store";
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

const base = { path: "notes.md", ref: "babc123", kind: "insert" as const, offset: 4 };

/** A run as it exists once its `suggestion.add` response has supplied an id. */
function boundRun(overrides: Partial<EditRun> = {}): EditRun {
	return {
		key: runKey(base.path, base.ref, base.kind),
		path: base.path,
		ref: base.ref,
		suggestionId: "s0a1b",
		text: "he",
		range: { start: 4, end: 6 },
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
		// The span grows with the text, so accept can still place the whole run.
		assert.deepEqual(decision.action === "extend" && decision.range, { start: 4, end: 9 });
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
		const decision = decideEdit(boundRun(), { ...base, kind: "remove", text: "x" });
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
		const op = createOp(run) as {
			markdown?: string;
			type: string;
			ref?: string;
			range?: { start: number; end: number };
		};
		assert.equal(op.markdown, "hello", "the record must hold the proposed text");
		assert.equal(op.type, "suggestion.add");
		assert.equal(op.ref, base.ref);
		assert.deepEqual(op.range, { start: 4, end: 9 }, "and the offset accept splices at");
	});

	test("the edit op carries the full accumulated text", () => {
		const op = editOp(boundRun({ text: "hello" })) as {
			markdown?: string;
			suggestionId?: string;
			range?: { start: number; end: number };
		};
		assert.equal(op.markdown, "hello");
		assert.equal(op.suggestionId, "s0a1b", "and targets the run's own record");
		assert.ok(op.range, "the range travels with the edit, not only with the create");
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
				run = { ...decision.run, text: decision.text, range: decision.range };
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
describe("a write must advance the revision the next write sends", () => {
	/**
	 * Found live: every keystroke logged `409 (Conflict)` and
	 * "[tracked-edit] could not persist the suggestion ... Base revision 6 does not match
	 * current revision 7."
	 *
	 * A successful POST returns the revision it produced, and that value is the
	 * `baseRevision` the NEXT request must send. The typing path applied the response's
	 * suggestion to the store but dropped its revision, so the very next keystroke sent
	 * the revision its own previous write had already superseded. The server refused it,
	 * the retry re-sent the same stale base, and the suggestion never persisted — while
	 * the comment path, which DID pass the revision through, kept working. That asymmetry
	 * is the tell.
	 *
	 * These drive the real store: `applyEvent` must adopt the event's revision, and
	 * `adoptRevision` covers writes that apply no local event.
	 */
	function seed() {
		useProofStore.setState({ byPath: {} });
		useProofStore.getState().applyEvent("d.md", {
			id: 0,
			type: "suggestion.added",
			at: new Date().toISOString(),
			by: "human",
			revision: 6,
		});
		// A loaded sidecar, as the editor would have.
		useProofStore.setState((s) => ({
			byPath: {
				...s.byPath,
				"d.md": {
					...s.byPath["d.md"],
					sidecar: {
						schemaVersion: 1,
						path: "d.md",
						revision: 6,
						createdAt: "",
						updatedAt: "",
						refMap: {},
						refAliases: {},
						comments: [],
						suggestions: [],
						archivedSuggestions: [],
						events: [],
						nextEventId: 1,
						lastAck: {},
						fingerprint: "",
					} as never,
					snapshotRevision: 6,
				},
			},
		}));
	}

	test("applyEvent adopts the revision the write produced", () => {
		seed();
		useProofStore.getState().applyEvent("d.md", {
			id: 12,
			type: "suggestion.added",
			at: new Date().toISOString(),
			by: "human",
			revision: 7,
		});
		assert.equal(
			useProofStore.getState().byPath["d.md"]?.snapshotRevision,
			7,
			"the next write's base must be 7, not the superseded 6",
		);
	});

	test("REGRESSION: an event with no revision leaves the next write stale", () => {
		seed();
		// What the buggy path sent: the suggestion, without the revision.
		useProofStore.getState().applyEvent("d.md", {
			id: 12,
			type: "suggestion.added",
			at: new Date().toISOString(),
			by: "human",
			suggestionId: "s1",
		});
		assert.equal(
			useProofStore.getState().byPath["d.md"]?.snapshotRevision,
			6,
			"still 6 — this is the state that made every later write 409",
		);
	});

	test("adoptRevision covers a write that applies no local event", () => {
		seed();
		useProofStore.getState().adoptRevision("d.md", 7);
		assert.equal(useProofStore.getState().byPath["d.md"]?.snapshotRevision, 7);
	});

	test("a late response for an older write cannot un-advance the base", () => {
		seed();
		useProofStore.getState().adoptRevision("d.md", 9);
		useProofStore.getState().adoptRevision("d.md", 8);
		assert.equal(
			useProofStore.getState().byPath["d.md"]?.snapshotRevision,
			9,
			"revision only moves forward",
		);
	});
});

describe("the base revision can only move forward", () => {
	/**
	 * The client sent `Base revision 0 does not match current revision 6`, then kept
	 * sending it. Revisions arrive from three places — a snapshot GET, a sidecar GET and
	 * a write response — and they race: a GET issued before a write can resolve after it.
	 * Any of them assigning its value unconditionally lets a late read roll the base
	 * backwards, after which every write is refused against a revision the client had
	 * already moved past, and the retry repeats the same stale base forever.
	 *
	 * These drive the real store methods against a stubbed fetch, so the guard is tested
	 * where it lives rather than re-implemented in the test.
	 */
	function seed(revision: number) {
		useProofStore.setState({
			byPath: {
				"d.md": {
					sidecar: null,
					snapshotRevision: revision,
					lastEventId: 0,
					snapshotBlocks: [],
				},
			},
		});
	}

	function stubSnapshot(revision: number) {
		// `loadSnapshot` reads `revision` and `blocks` from the response.
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ revision, blocks: [] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
	}

	test("REGRESSION: a late snapshot read cannot lower the base", async () => {
		seed(7);
		stubSnapshot(6); // the GET left before the write that produced 7
		await useProofStore.getState().loadSnapshot("d.md");
		assert.equal(
			useProofStore.getState().byPath["d.md"]?.snapshotRevision,
			7,
			"a read that is behind must not roll the base back",
		);
	});

	test("a newer snapshot read still advances the base", async () => {
		seed(6);
		stubSnapshot(8);
		await useProofStore.getState().loadSnapshot("d.md");
		assert.equal(useProofStore.getState().byPath["d.md"]?.snapshotRevision, 8);
	});
});
