/**
 * The coalescing decision for typed suggestions, as a pure function.
 *
 * WHY THIS IS A SEPARATE MODULE
 * -----------------------------
 * The run state machine used to live inside the React hook, where the only tests
 * that could reach it were regexes over source text. That is exactly how a real
 * defect survived a green suite: `suggestionId` was never bound to the run, so
 * `continuing` was permanently false and coalescing could never happen — while a
 * test asserting that `COALESCE_MS` and a variable named `continuing` both
 * existed passed happily. Text assertions cannot see a state machine.
 *
 * So the decision is extracted here, where it can be driven directly: give it a
 * run and an edit, get back what should happen. The hook keeps the React wiring
 * (refs, timers, network) and delegates the judgement.
 *
 * THE DURABILITY RULE
 * -------------------
 * A run is only extendable once its suggestion EXISTS in the sidecar. Until the
 * `suggestion.add` response supplies an id, there is no record to extend, and
 * treating the run as continuing would accumulate text that nothing durable
 * holds. That is why `continuing` requires a bound id rather than just a matching
 * key, and it is the precise condition the old code got wrong.
 */

/** How long a run of typing stays open before it becomes its own suggestion. */
export const COALESCE_MS = 1200;

export type RunKind = "insert" | "delete";

/** A run of consecutive tracked edits being merged into one suggestion. */
export interface EditRun {
	/** `${path}:${ref}:${kind}` — a run never spans a block, document, or kind. */
	key: string;
	path: string;
	ref: string;
	/**
	 * The sidecar's id for this run's suggestion, or null until `suggestion.add`
	 * returns. Null is the whole ballgame: without it there is nothing to extend.
	 */
	suggestionId: string | null;
	/** The proposed text accumulated so far. */
	text: string;
	kind: RunKind;
}

export type RunDecision<R extends EditRun = EditRun> =
	/** Extend the open run: append text, then push it to the sidecar. */
	| { action: "extend"; run: R; text: string }
	/** Start a new run; its suggestion does not exist yet, so create it. */
	| { action: "start"; key: string; path: string; ref: string; text: string; kind: RunKind };

/** The key that scopes a run. */
export function runKey(path: string, ref: string, kind: RunKind): string {
	return `${path}:${ref}:${kind}`;
}

/**
 * Decide what a tracked edit does to the currently open run.
 *
 * `open` is the run in progress, if any. A run continues only when the key
 * matches AND its suggestion id is bound; otherwise this edit starts a new
 * suggestion.
 */
export function decideEdit<R extends EditRun>(
	open: R | null,
	edit: { path: string; ref: string; kind: RunKind; text: string },
): RunDecision<R> {
	const key = runKey(edit.path, edit.ref, edit.kind);
	if (open !== null && open.key === key && open.suggestionId !== null) {
		return { action: "extend", run: open, text: open.text + edit.text };
	}
	return {
		action: "start",
		key,
		path: edit.path,
		ref: edit.ref,
		text: edit.text,
		kind: edit.kind,
	};
}

/**
 * Whether a subsequent edit would extend the given run rather than start a new
 * one. Exposed so tests can assert the behaviour directly, and so a caller can
 * ask the question without constructing a decision.
 */
export function willExtend(
	open: EditRun | null,
	edit: { path: string; ref: string; kind: RunKind },
): boolean {
	if (open === null || open.suggestionId === null) return false;
	return open.key === runKey(edit.path, edit.ref, edit.kind);
}

/** A fresh run for a starting edit. Its id arrives with the create response. */
export function newRun(decision: Extract<RunDecision, { action: "start" }>): EditRun {
	return {
		key: decision.key,
		path: decision.path,
		ref: decision.ref,
		suggestionId: null,
		text: decision.text,
		kind: decision.kind,
	};
}

/** The op that creates the record for a starting run, carrying its text. */
export function createOp(run: EditRun): Record<string, unknown> {
	return {
		type: "suggestion.add",
		ref: run.ref,
		kind: run.kind,
		// The proposed text is recorded. An earlier version posted "" here, so the
		// suggestion existed but held nothing and a reload lost the proposal.
		markdown: run.text,
		basis: "suggested",
	};
}

/** The op that updates a run that already has a record. */
export function editOp(run: EditRun): Record<string, unknown> {
	return { type: "suggestion.edit", suggestionId: run.suggestionId, markdown: run.text };
}