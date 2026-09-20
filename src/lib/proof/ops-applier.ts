import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RootContent } from "mdast";
import type {
	Op,
	Block,
	Snapshot,
	Sidecar,
	ProofEvent,
	Comment,
	Suggestion,
	AnchorStatus,
} from "./types";
import { anchorForBlock, anchorForRange, migrateSidecar, projectCommentViews, resolveAnchor } from "./anchor";
import { parseBlocks, blockToMarkdown, blocksToMarkdown } from "./blocks";
import { assignRefs, resolveRef, computeRefDelta, textHash } from "./block-refs";
import { readSidecar, writeSidecar, emptySidecar } from "./sidecar";
import { withFileMutex, workspaceLockKey } from "./mutex";
import { emitEvents, trimEvents } from "./event-bus";
import { SIDECAR_EVENT_TRIM_SIZE, SIDECAR_TRIM_EVERY_N_MUTATIONS } from "../proof-config";
import { mergeBlock } from "./block-merge";

function sha256file(content: string): string {
	return "sha256:" + createHash("sha256").update(content, "utf8").digest("hex");
}

function shortId(prefix: string): string {
	return prefix + Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
}

function nowIso(): string {
	return new Date().toISOString();
}

function cloneSidecar(sc: Sidecar): Sidecar {
	return JSON.parse(JSON.stringify(sc)) as Sidecar;
}

function isMarkdownPath(p: string): boolean {
	return p.endsWith(".md") || p.endsWith(".markdown");
}

function splitLines(content: string): string[] {
	return content.replace(/\r\n/g, "\n").split("\n");
}

function hashLineRange(lines: string[], lineStart: number, lineEnd: number): string | null {
	if (lineStart < 1 || lineEnd < lineStart) return null;
	if (lineEnd > lines.length) return null;
	return textHash(lines.slice(lineStart - 1, lineEnd).join("\n"));
}

export async function reconcileTextCommentAnchors(rootDir: string, mdPath: string, content: string, sidecar: Sidecar): Promise<boolean> {
	const lines = splitLines(content);
	let changed = false;

	for (const comment of sidecar.comments) {
		const anchor = comment.lineAnchor;
		if (!anchor) continue;

		const currentHash = hashLineRange(lines, anchor.lineStart, anchor.lineEnd);
		if (currentHash === anchor.textHash) {
			if (comment.stale) {
				comment.stale = false;
				changed = true;
			}
			continue;
		}

		let reanchored: { lineStart: number; lineEnd: number } | null = null;
		for (let delta = -3; delta <= 3; delta++) {
			if (delta === 0) continue;
			const start = anchor.lineStart + delta;
			const end = anchor.lineEnd + delta;
			if (hashLineRange(lines, start, end) === anchor.textHash) {
				reanchored = { lineStart: start, lineEnd: end };
				break;
			}
		}

		if (reanchored) {
			anchor.lineStart = reanchored.lineStart;
			anchor.lineEnd = reanchored.lineEnd;
			if (comment.stale) comment.stale = false;
			changed = true;
		} else if (!comment.stale) {
			comment.stale = true;
			changed = true;
		}
	}

	if (changed) {
		sidecar.updatedAt = nowIso();
		await writeSidecar(rootDir, mdPath, sidecar);
	}

	return changed;
}

/** Parse op markdown into mdast nodes and assign refs. */
function opMarkdownToBlocks(
	markdown: string,
	workingBlocks: Block[],
): { nodes: RootContent[]; refs: string[] } {
	const nodes = parseBlocks(markdown);
	const usedRefs = new Set(workingBlocks.map((b) => b.ref));
	const refs: string[] = [];

	for (let i = 0; i < nodes.length; i++) {
		const node = nodes[i];
		let md = blockToMarkdown(node);

		// Mint a provisional ref for this new block
		const hash = "b" + createHash("sha256").update(md, "utf8").digest("hex").slice(0, 6);
		let ref = hash;
		let counter = 0;
		while (usedRefs.has(ref)) {
			ref = `${hash}_${counter++}`;
		}
		usedRefs.add(ref);
		refs.push(ref);

	}

	return { nodes, refs };
}

/**
 * Recompute a sidecar's block refs against `content`, cancelling any comment whose
 * anchor no longer exists. Exported for callers that write markdown directly rather
 * than through `applyOps` — notably the editor's own save route.
 *
 * Without this, a direct write leaves `refMap` describing the OLD document while the
 * file on disk is the new one, so comments keep pointing at refs that are gone and
 * nothing cancels them. Observed live: three comments rendered as normal margin cards
 * with no highlight anywhere in the document, because the save that removed their text
 * never reconciled.
 */
export function reconcileRefsAndCancelOrphans(sidecar: Sidecar, content: string): void {
	const nodes = parseBlocks(content);

	// Build the hash -> ref map that `assignRefs` used last time, so a block whose
	// text is unchanged but whose ref was taken by an identical sibling can be
	// aliased rather than reported as gone.
	const oldHashToRef = new Map<string, string>();
	for (const [ref, entry] of Object.entries(sidecar.refMap)) {
		if (!oldHashToRef.has(entry.textHash)) oldHashToRef.set(entry.textHash, ref);
	}

	const { blocks, newRefMap } = assignRefs(nodes, sidecar);
	// `refMap`'s keys are inserted in document order, so they are the previous block
	// ordering — what lets an edited block be matched to the ref it used to hold.
	const { refAliases } = computeRefDelta(sidecar.refMap, oldHashToRef, blocks);

	sidecar.refMap = newRefMap;
	// Keep the previous generation of aliases alongside the new one, as applyOps does.
	sidecar.refAliases = { ...sidecar.refAliases, ...refAliases };
	markOrphanedRefsStale(sidecar, newRefMap, blocks);
}

/**
 * True when `ref` is gone but its content survives under another ref.
 *
 * Refs are content-derived, so two identical blocks are genuinely different blocks
 * that happen to share a hash: the first gets `b<sha>`, the second `b<sha>_1`. Delete
 * the first and the survivor reclaims `b<sha>` while `b<sha>_1` simply disappears —
 * even though the text a comment was anchored to is still sitting in the document.
 * Cancelling there is wrong: the user deleted a *different* paragraph.
 *
 * `computeRefDelta` already records exactly this as an alias, so this asks whether the
 * dead ref was aliased to a ref that still exists. Without it, deleting one of two
 * identical paragraphs silently cancels the comment on the other, which is one-way
 * (cancellation has no un-cancel path).
 */
function survivesViaAlias(sidecar: Sidecar, ref: string, validRefs: Set<string>): boolean {
	// Optional: migration drops `refAliases` (see anchor.ts), so a sidecar that has
	// been migrated no longer carries the map this reads. Absent means "no alias
	// recorded", which is the honest answer — the alias mechanism is exactly what
	// the anchor record replaces.
	const aliased = sidecar.refAliases?.[ref];
	return Boolean(aliased && validRefs.has(aliased));
}

/**
 * Refuse a mutation on a suggestion the UI is treating as stale.
 *
 * WHY `stale` ALONE IS THE TEST, AND NOT WHETHER THE REF RESOLVES
 * ---------------------------------------------------------------
 * `markOrphanedRefsStale` only ever SETS `stale = true`; nothing clears it for
 * suggestions. Refs are content-derived, so this sequence is reachable:
 *
 *   1. `Alpha paragraph.` has ref R; a suggestion targets R.
 *   2. Delete that paragraph  -> the suggestion is marked stale, and the margin
 *      stops showing it.
 *   3. Type the same paragraph again -> R is valid again, but `stale` stays true
 *      and the UI still hides the suggestion.
 *   4. `suggestion.accept` now finds its block and WRITES THE FILE for a
 *      suggestion the user can no longer see.
 *
 * An earlier guard only covered a permanently-dead ref such as `bDEAD`, which the
 * ordinary block lookup refuses with BLOCK_NOT_FOUND. That proved the wrong thing:
 * it showed a *dead* suggestion cannot be accepted, not that a *stale* one cannot.
 * The check below is therefore about the recorded state, not about whether the ref
 * happens to resolve right now — a stale suggestion is one the user was told is
 * gone, so no mutation may act on it. Recovering one would need an explicit,
 * validated un-stale transition, which does not exist and is not implied here.
 */
function refuseStaleSuggestion(
	sidecar: Sidecar,
	mdPath: string,
	workingBlocks: Block[],
	suggestionId: string,
): Extract<ApplyResult, { ok: false }> | null {
	const sug = sidecar.suggestions.find((s) => s.id === suggestionId);
	if (!sug || !sug.stale) return null;
	return {
		ok: false,
		status: 409,
		code: "SUGGESTION_STALE",
		message:
			`Suggestion "${suggestionId}" is stale: its anchor was removed, so it cannot be ` +
			`changed until the anchor is restored and the suggestion is revived.`,
		snapshot: buildSnapshot(mdPath, workingBlocks, sidecar),
	};
}

function markOrphanedRefsStale(
	sidecar: Sidecar,
	newRefMap: Record<string, unknown>,
	blocks: Block[] = [],
): void {
	const validRefs = new Set(Object.keys(newRefMap));

	/**
	 * Whether this record's reference disappearing should actually orphan it.
	 *
	 * Two identity systems meet here and the order between them is the whole point.
	 * A record that carries an `anchorId` has a durable identity: its anchor is
	 * what decides, and a ref it no longer recognises means nothing on its own —
	 * refs are content hashes, so they change on every edit inside the block. Only
	 * a record with no anchor at all still falls back to the alias guess, which is
	 * the mechanism the anchor record exists to retire.
	 *
	 * `blocks` empty means the caller had no document to resolve against (the read
	 * path migrates before it gets here, so this is the leftover case). Then a
	 * missing ref is all the evidence available and the old behaviour stands.
	 */
	// `ref` is optional on a comment (it is a legacy-v1 field), so an unanchored
	// comment with no ref at all has nothing to lose and is never orphaned here.
	const isOrphaned = (record: { ref?: string; anchorId?: string }): boolean => {
		if (validRefs.has(record.ref ?? "")) return false;

		// An anchored record is judged by its anchor, and only its anchor.
		//
		// A ref is a content hash, so it changes on ANY edit inside the block — which
		// is why cancelling on ref loss alone was wrong: it destroyed annotations for
		// edits that left their text untouched. The resolver already answers the real
		// question for both anchor kinds: a range anchor searches for its quote, and a
		// block anchor follows its slot (the whole block IS the annotation, so its
		// slot surviving is its survival — anchor-resolution.test.ts pins that).
		//
		// Only "lost" orphans anything. "moved" and "ambiguous" both mean the text was
		// found, so the annotation stays and the resolver's offsets are used instead.
		if (record.anchorId && blocks.length > 0) {
			const anchor = sidecar.anchors?.[record.anchorId];
			if (anchor) return resolveAnchor(sidecar, anchor, blocks).status === "lost";
		}

		// No anchor, or nothing to resolve against: the legacy ref-and-alias guess is
		// all the evidence there is. This is the path the anchor record replaces.
		if (!record.ref) return false;
		return !survivesViaAlias(sidecar, record.ref, validRefs);
	};

	for (const s of sidecar.suggestions) {
		if (s.status !== "pending") continue;

		// A suggestion is also judged against the text it proposed to change, which
		// `baseMarkdown` records. The anchor alone is not enough here: a suggestion
		// added without a range gets a BLOCK anchor, and a block anchor follows its
		// slot, so rewriting the paragraph reports "moved" and the suggestion would
		// stay applicable to text it was never written against. Applying it would
		// then overwrite the rewrite with a merge base that no longer exists.
		if (s.baseMarkdown && blocks.length > 0) {
			const base = blocks.find((b) => b.ref === s.ref);
			// Ref gone, or the block no longer contains the text this was written
			// against — either way the proposal cannot be applied as stated.
			if (!base || !base.markdown.includes(s.baseMarkdown)) {
				s.stale = true;
				continue;
			}
		}
		if (s.stale) continue;
		if (isOrphaned(s)) {
			s.stale = true;
		}
	}
	// A comment whose text is gone is MARKED LOST, not destroyed.
	//
	// This follows Google Docs, which is the standard this feature is built to: a
	// comment is never silently dropped when its anchor goes away, it is kept and
	// shown as detached. Two earlier designs were both wrong here. Latching
	// `stale = true` and waiting for a re-anchor UI parked it forever, because that
	// UI was never built. Cancelling it removed something the user wrote as a side
	// effect of somebody else's save, which is unrecoverable and, in a review tool,
	// the worst of the three.
	//
	// Marking it lost also keeps it out of the pending set Copy-as-prompt reads, so
	// a deleted sentence cannot leak a phantom instruction into an agent's prompt,
	// while the card stays in the margin for the human.
	for (const c of sidecar.comments) {
		if (!c.resolved && isOrphaned(c)) {
			c.anchorStatus = "lost";
			c.stale = false;
		}
	}
}

/**
 * Build the read model for one document.
 *
 * Resolution happens HERE, against the same `blocks` this snapshot ships, rather than in
 * the browser. The editor reads its blocks and its sidecar from two independent store
 * paths fed by two separate HTTP calls, and a `Snapshot` carries no anchor records — so a
 * client-side resolver would have nothing to resolve against. Resolving per read also
 * means the ranges and the block list can never disagree about which revision they
 * describe, which is the coordinate mismatch that painted the wrong span in a list item.
 */
function buildSnapshot(
	mdPath: string,
	blocks: Block[],
	sidecar: Sidecar,
): Snapshot {
	const views = projectCommentViews(sidecar, sidecar.comments, blocks);
	const withStatus = <T extends { id: string; anchorId?: string; anchorStatus?: AnchorStatus }>(
		items: T[],
	): T[] =>
		items.map((item) => {
			const view = views[item.id];
			if (!view) return item;
			return { ...item, anchorStatus: view.status };
		});

	return {
		path: mdPath,
		revision: sidecar.revision,
		createdAt: sidecar.createdAt,
		updatedAt: sidecar.updatedAt,
		fingerprint: sidecar.fingerprint,
		blocks,
		commentViews: views,
		comments: withStatus(sidecar.comments),
		suggestions: withStatus(sidecar.suggestions.filter((s) => s.status === "pending")),
		lastEventId: sidecar.nextEventId - 1,
	};
}

/**
 * Reconcile a sidecar after a file was modified outside of block-ops.
 * Rebuilds refMap, bumps revision, marks orphaned anchors stale, emits event, writes sidecar.
 *
 * The function does not acquire its own mutex; callers must hold the workspace
 * lock (`workspaceLockKey(rootDir, mdPath)`).
 *
 * Used by:
 *   - readSnapshot: eventType="file.externallyEdited", by="system"
 *   - raw-fs PUT (Phase 2): eventType="file.rawWritten", by="ai:<id>"
 */
export async function reconcileSidecar(args: {
	rootDir: string;
	mdPath: string;
	content: string;
	sidecar: Sidecar; // mutated in place
	by: string;
	eventType: string;
	fingerprint: string; // pre-computed sha256 of content
}): Promise<{ snapshot: Snapshot; blocks: Block[] }> {
	const { rootDir, mdPath, content, sidecar, by, eventType, fingerprint } = args;
	const nodes = parseBlocks(content);
	const { blocks, newRefMap } = assignRefs(nodes, sidecar);

	// Migrate BEFORE anything judges an annotation by its ref.
	//
	// This is the only production site with the blocks that migration needs, and
	// until recently nothing called it here: every `readSidecar` call passes two
	// arguments, so migration never ran outside tests and legacy records never
	// acquired an anchor. That left `markOrphanedRefsStale` below deciding
	// orphanhood purely from ref disappearance — the content-derived identity this
	// rebuild exists to stop relying on. Migrating first means a record that has an
	// anchor is judged against it, and one that cannot be anchored is marked lost
	// honestly rather than cancelled because a hash moved.
	//
	// `blocks` here are the pre-edit shape on the write path, which is what the
	// stored offsets and quotes were taken against.
	const migrated = migrateSidecar(sidecar, blocks);
	if (migrated.changed) Object.assign(sidecar, migrated.sidecar);

	const oldFingerprint = sidecar.fingerprint;
	sidecar.refMap = newRefMap;
	sidecar.revision += 1;
	sidecar.updatedAt = nowIso();
	sidecar.fingerprint = fingerprint;
	markOrphanedRefsStale(sidecar, newRefMap, blocks);
	const eventPayload: Omit<ProofEvent, "id"> & Record<string, unknown> = {
		type: eventType,
		at: nowIso(),
		by,
		fingerprint,
	};
	if (eventType === "file.rawWritten") {
		eventPayload.oldSha = oldFingerprint;
		eventPayload.newSha = fingerprint;
	}
	emitEvents(sidecar, [eventPayload as Omit<ProofEvent, "id">]);
	await writeSidecar(rootDir, mdPath, sidecar);
	return { snapshot: buildSnapshot(mdPath, blocks, sidecar), blocks };
}

/**
 * Pure read: load file, parse blocks, assign refs, return snapshot.
 * Detects external edits (fingerprint mismatch) and records them in the sidecar.
 */
export async function readSnapshot(
	rootDir: string,
	mdPath: string,
): Promise<Snapshot | null> {
	const absPath = path.join(rootDir, mdPath);
	let content: string;
	try {
		content = await readFile(absPath, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw err;
	}

	const sidecar = (await readSidecar(rootDir, mdPath)) ?? emptySidecar(mdPath);
	const fingerprint = sha256file(content);

	// Detect external edits: fingerprint set and mismatched
	if (sidecar.fingerprint && sidecar.fingerprint !== fingerprint) {
		return withFileMutex(workspaceLockKey(rootDir, mdPath), async () => {
			// Re-read under mutex to avoid TOCTOU
			let freshContent: string;
			try {
				freshContent = await readFile(absPath, "utf-8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
				throw err;
			}
			const freshSidecar = (await readSidecar(rootDir, mdPath)) ?? emptySidecar(mdPath);
			const freshFingerprint = sha256file(freshContent);

			if (freshSidecar.fingerprint && freshSidecar.fingerprint !== freshFingerprint) {
				const { snapshot } = await reconcileSidecar({
					rootDir,
					mdPath,
					content: freshContent,
					sidecar: freshSidecar,
					by: "system",
					eventType: "file.externallyEdited",
					fingerprint: freshFingerprint,
				});
				return snapshot;
			}

			// Another writer already updated — just build snapshot from current state
			const nodes = parseBlocks(freshContent);
			const { blocks } = assignRefs(nodes, freshSidecar);
			return buildSnapshot(mdPath, blocks, freshSidecar);
		});
	}

	const nodes = parseBlocks(content);
	const { blocks, newRefMap } = assignRefs(nodes, sidecar);

	// Migrate here too: this is the first production path where a read has the
	// document, and `buildSnapshot` below projects comment views from anchors. A
	// record that is still legacy at this point has no anchor to project, so the
	// migration has to happen before the snapshot is built, not after.
	const migrated = migrateSidecar(sidecar, blocks);
	if (migrated.changed) Object.assign(sidecar, migrated.sidecar);

	// Sync sidecar refMap if it's empty (first read) and persist fingerprint
	if (Object.keys(sidecar.refMap).length === 0) {
		sidecar.refMap = newRefMap;
		sidecar.fingerprint = fingerprint;
		// Persist so future readSnapshot calls can detect external edits
		await writeSidecar(rootDir, mdPath, sidecar);
	} else if (migrated.changed) {
		// A migrated sidecar must reach disk deliberately. Without this it is
		// migrated in memory on every read and re-derived each time, so an external
		// edit arriving first would still be reconciled against the legacy shape.
		await writeSidecar(rootDir, mdPath, sidecar);
	}

	return buildSnapshot(mdPath, blocks, sidecar);
}

type ApplyResult =
	| { ok: true; snapshot: Snapshot; emittedEvents: ProofEvent[] }
	| {
			ok: false;
			status: number;
			code: string;
			message: string;
			snapshot?: Snapshot;
	  };

async function applyTextCommentOps(args: {
	rootDir: string;
	mdPath: string;
	baseRevision: number;
	by: string;
	ops: Op[];
}): Promise<ApplyResult> {
	const { rootDir, mdPath, baseRevision, by, ops } = args;

	return withFileMutex(workspaceLockKey(rootDir, mdPath), async (): Promise<ApplyResult> => {
		const absPath = path.join(rootDir, mdPath);

		let content: string;
		try {
			content = await readFile(absPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { ok: false, status: 404, code: "FILE_NOT_FOUND", message: "File not found" };
			}
			throw err;
		}

		const fingerprint = sha256file(content);
		const lines = splitLines(content);
		let sidecar = (await readSidecar(rootDir, mdPath)) ?? emptySidecar(mdPath);
		sidecar.fingerprint = fingerprint;
		await reconcileTextCommentAnchors(rootDir, mdPath, content, sidecar);

		if (baseRevision !== sidecar.revision) {
			return {
				ok: false,
				status: 409,
				code: "STALE_REVISION",
				message: `Base revision ${baseRevision} does not match current revision ${sidecar.revision}.`,
				snapshot: buildSnapshot(mdPath, [], sidecar),
			};
		}

		const workingSidecar = cloneSidecar(sidecar);
		const workingEvents: Array<Omit<ProofEvent, "id">> = [];

		for (const op of ops) {
			const at = nowIso();
			switch (op.type) {
				case "comment.add": {
					const anchor = op.lineAnchor;
					if (
						!anchor ||
						!Number.isInteger(anchor.lineStart) ||
						!Number.isInteger(anchor.lineEnd) ||
						anchor.lineStart < 1 ||
						anchor.lineEnd < anchor.lineStart ||
						typeof anchor.textHash !== "string" ||
						!anchor.textHash
					) {
						return {
							ok: false,
							status: 400,
							code: "INVALID_PAYLOAD",
							message: "Text comments require a valid lineAnchor",
						};
					}
					const currentHash = hashLineRange(lines, anchor.lineStart, anchor.lineEnd);
					if (currentHash !== anchor.textHash) {
						return {
							ok: false,
							status: 400,
							code: "INVALID_PAYLOAD",
							message: "Text comment anchor does not match current file content",
						};
					}
					const comment: Comment = {
						id: shortId("c"),
						lineAnchor: { ...anchor },
						resolved: false,
						createdAt: at,
						turns: [{ by, text: op.text, at }],
					};
					if (op.kind === "instruction") {
						comment.kind = "instruction";
						comment.instructionState = "draft";
						if (op.fromCommentId) comment.fromCommentId = op.fromCommentId;
					}
					workingSidecar.comments.push(comment);
					workingEvents.push({
						type: "comment.added",
						at,
						by,
						commentId: comment.id,
						text: op.text,
						lineAnchor: comment.lineAnchor,
						kind: comment.kind,
					});
					break;
				}
				case "comment.mark": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, [], workingSidecar),
						};
					}
					comment.instructionState = op.instructionState;
					if (op.runId !== undefined) comment.runId = op.runId;
					workingEvents.push({
						type: "comment.marked",
						at,
						by,
						commentId: op.commentId,
						instructionState: op.instructionState,
						runId: op.runId,
					});
					break;
				}
				case "comment.reply": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, [], workingSidecar),
						};
					}
					comment.turns.push({ by, text: op.text, at });
					workingEvents.push({ type: "comment.replied", at, by, commentId: op.commentId, text: op.text });
					break;
				}
				case "comment.edit": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment || comment.turns.length === 0) {
						return { ok: false, status: 409, code: "COMMENT_NOT_FOUND", message: `Comment "${op.commentId}" not found.`, snapshot: buildSnapshot(mdPath, [], workingSidecar) };
					}
					comment.turns[0].text = op.text;
					workingEvents.push({ type: "comment.edited", at, by, commentId: op.commentId, text: op.text });
					break;
				}
				case "comment.delete": {
					const commentIdx = workingSidecar.comments.findIndex((c) => c.id === op.commentId);
					if (commentIdx === -1) {
						return { ok: false, status: 409, code: "COMMENT_NOT_FOUND", message: `Comment "${op.commentId}" not found.`, snapshot: buildSnapshot(mdPath, [], workingSidecar) };
					}
					workingSidecar.comments.splice(commentIdx, 1);
					workingEvents.push({ type: "comment.deleted", at, by, commentId: op.commentId });
					break;
				}
				case "comment.resolve": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, [], workingSidecar),
						};
					}
					comment.resolved = true;
					workingEvents.push({ type: "comment.resolved", at, by, commentId: op.commentId });
					break;
				}
				case "comment.reopen": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, [], workingSidecar),
						};
					}
					comment.resolved = false;
					workingEvents.push({ type: "comment.reopened", at, by, commentId: op.commentId });
					break;
				}
				default:
					return {
						ok: false,
						status: 400,
						code: "INVALID_PATH",
						message: "Only comment ops are allowed on text files",
					};
			}
		}

		// Comment ops on text files never change document content, so the content
		// revision must not move (see applyOps for why bumping it breaks agent edits).
		workingSidecar.updatedAt = nowIso();
		workingSidecar.fingerprint = fingerprint;

		const emitted = emitEvents(workingSidecar, workingEvents);
		if (workingSidecar.revision % SIDECAR_TRIM_EVERY_N_MUTATIONS === 0) {
			trimEvents(workingSidecar, SIDECAR_EVENT_TRIM_SIZE);
		}

		await writeSidecar(rootDir, mdPath, workingSidecar);

		return {
			ok: true,
			snapshot: buildSnapshot(mdPath, [], workingSidecar),
			emittedEvents: emitted,
		};
	});
}

/**
 * Apply a batch of ops to a file, with revision check, mutex, and atomic write.
 */
export async function applyOps(args: {
	rootDir: string;
	mdPath: string;
	baseRevision: number;
	by: string;
	ops: Op[];
}): Promise<ApplyResult> {
	if (!isMarkdownPath(args.mdPath)) return applyTextCommentOps(args);

	const { rootDir, mdPath, baseRevision, by, ops } = args;

	return withFileMutex(workspaceLockKey(rootDir, mdPath), async (): Promise<ApplyResult> => {
		const absPath = path.join(rootDir, mdPath);

		let content: string;
		try {
			content = await readFile(absPath, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code === "ENOENT") {
				return { ok: false, status: 404, code: "FILE_NOT_FOUND", message: "File not found" };
			}
			throw err;
		}

		const fingerprint = sha256file(content);
		let sidecar = (await readSidecar(rootDir, mdPath)) ?? emptySidecar(mdPath);

		// Detect external edits — reconcile eagerly inside the mutex (R2: do not let lazy reconcile miss)
		if (sidecar.fingerprint && sidecar.fingerprint !== fingerprint) {
			const { snapshot: freshSnapshot } = await reconcileSidecar({
				rootDir,
				mdPath,
				content,
				sidecar,
				by: "system",
				eventType: "file.externallyEdited",
				fingerprint,
			});
			// Return STALE_REVISION so caller knows to re-fetch
			return {
				ok: false,
				status: 409,
				code: "STALE_REVISION",
				message: "File was externally edited. Fetch the new snapshot and retry.",
				snapshot: freshSnapshot,
			};
		}

		// Initialize fingerprint if not set
		if (!sidecar.fingerprint) {
			sidecar.fingerprint = fingerprint;
		}

		const nodes = parseBlocks(content);
		const { blocks: assignedBlocks, newRefMap } = assignRefs(nodes, sidecar);
		// Keep the ordering this reparse is about to destroy. An anchor still names a ref
		// from that ordering, and resolution needs it to find the block that took the
		// slot — otherwise a rewritten block's anchors have nothing to search.
		sidecar.prevRefOrder = Object.keys(sidecar.refMap);
		sidecar.refMap = newRefMap;

		// Revision check
		if (baseRevision !== sidecar.revision) {
			return {
				ok: false,
				status: 409,
				code: "STALE_REVISION",
				message: `Base revision ${baseRevision} does not match current revision ${sidecar.revision}.`,
				snapshot: buildSnapshot(mdPath, assignedBlocks, sidecar),
			};
		}

		// Working copies
		let workingNodes = [...nodes];
		let workingBlocks = [...assignedBlocks];
		const workingSidecar = cloneSidecar(sidecar);
		const workingEvents: Array<Omit<ProofEvent, "id">> = [];
		const collectedAliases: Record<string, string> = {};

		const currentRefs = () => new Set(workingBlocks.map((b) => b.ref));

		/**
		 * Locate the block an op addresses, by anchor when it has one.
		 *
		 * An anchor is the durable identity, so it wins: the ref it was last seen under
		 * may no longer exist because the text changed, while the anchor still resolves
		 * by content. Falls back to the ref lookup for ops that carry only a ref, which
		 * is every v1-era caller.
		 */
		function findBlockIndex(ref: string, anchorId?: string): number {
			if (anchorId) {
				const anchor = workingSidecar.anchors[anchorId];
				if (anchor) {
					const r = resolveAnchor(workingSidecar, anchor, workingBlocks);
					if (r.ref) return workingBlocks.findIndex((b) => b.ref === r.ref);
					return -1;
				}
			}
			const resolved = resolveRef(workingSidecar, ref, currentRefs());
			if (!resolved) return -1;
			return workingBlocks.findIndex((b) => b.ref === resolved);
		}

		// Apply ops
		for (const op of ops) {
			const at = nowIso();

			switch (op.type) {
				case "block.replace": {
					const idx = findBlockIndex(op.ref);
					if (idx === -1) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const oldRef = workingBlocks[idx].ref;

					const { nodes: newNodes, refs: newRefs } = opMarkdownToBlocks(
						op.markdown, workingBlocks.filter((_, i) => i !== idx),
					);

					workingNodes.splice(idx, 1, ...newNodes);
					const newBlocks = newNodes.map((n, ni) => {
						const md = blockToMarkdown(n);
						return { ref: newRefs[ni], type: "paragraph" as const, markdown: md };
					});
					workingBlocks.splice(idx, 1, ...newBlocks);

					// Re-assign proper block types
					const reparse = assignRefs(newNodes, null);
					for (let ni = 0; ni < newBlocks.length; ni++) {
						workingBlocks[idx + ni] = { ...reparse.blocks[ni], ref: newRefs[ni] };
					}

					if (newRefs[0]) collectedAliases[oldRef] = newRefs[0];
					workingEvents.push({
						type: "block.replaced",
						at,
						by,
						ref: oldRef,
						newRef: newRefs[0] ?? null,
					});
					break;
				}

				case "block.insertAfter": {
					const idx = findBlockIndex(op.ref);
					if (idx === -1) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const { nodes: newNodes, refs: newRefs } = opMarkdownToBlocks(
						op.markdown, workingBlocks,
					);
					const newBlockList = newNodes.map((n, ni) => {
						const reparse = assignRefs([n], null);
						return { ...reparse.blocks[0], ref: newRefs[ni] };
					});
					workingNodes.splice(idx + 1, 0, ...newNodes);
					workingBlocks.splice(idx + 1, 0, ...newBlockList);
					workingEvents.push({ type: "block.inserted", at, by, after: op.ref, refs: newRefs });
					break;
				}

				case "block.insertBefore": {
					const idx = findBlockIndex(op.ref);
					if (idx === -1) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const { nodes: newNodes, refs: newRefs } = opMarkdownToBlocks(
						op.markdown, workingBlocks,
					);
					const newBlockList = newNodes.map((n, ni) => {
						const reparse = assignRefs([n], null);
						return { ...reparse.blocks[0], ref: newRefs[ni] };
					});
					workingNodes.splice(idx, 0, ...newNodes);
					workingBlocks.splice(idx, 0, ...newBlockList);
					workingEvents.push({ type: "block.inserted", at, by, before: op.ref, refs: newRefs });
					break;
				}

				case "block.delete": {
					const idx = findBlockIndex(op.ref);
					if (idx === -1) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					workingNodes.splice(idx, 1);
					workingBlocks.splice(idx, 1);
					workingEvents.push({ type: "block.deleted", at, by, ref: op.ref });
					break;
				}

				case "block.append": {
					const { nodes: newNodes, refs: newRefs } = opMarkdownToBlocks(
						op.markdown, workingBlocks,
					);
					const newBlockList = newNodes.map((n, ni) => {
						const reparse = assignRefs([n], null);
						return { ...reparse.blocks[0], ref: newRefs[ni] };
					});
					workingNodes.push(...newNodes);
					workingBlocks.push(...newBlockList);
					workingEvents.push({ type: "block.inserted", at, by, position: "end", refs: newRefs });
					break;
				}

				case "block.prepend": {
					const { nodes: newNodes, refs: newRefs } = opMarkdownToBlocks(
						op.markdown, workingBlocks,
					);
					const newBlockList = newNodes.map((n, ni) => {
						const reparse = assignRefs([n], null);
						return { ...reparse.blocks[0], ref: newRefs[ni] };
					});
					workingNodes.unshift(...newNodes);
					workingBlocks.unshift(...newBlockList);
					workingEvents.push({ type: "block.inserted", at, by, position: "start", refs: newRefs });
					break;
				}

				case "comment.add": {
					if (!op.ref) {
						return {
							ok: false,
							status: 400,
							code: "INVALID_PAYLOAD",
							message: "Markdown comments require ref",
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const refs = currentRefs();
					const resolved = resolveRef(workingSidecar, op.ref, refs);
					if (!resolved) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const comment: Comment = {
						id: shortId("c"),
						ref: resolved,
						resolved: false,
						createdAt: at,
						turns: [{ by, text: op.text, at }],
					};
					// Phase 2: an exact-text anchor is what lets the UI highlight the
					// commented words (DoD #1) and re-find them after edits (DoD #6).
					// Validate against the block's current markdown so a corrupt range
					// is rejected at the boundary rather than rendered wrong.
					if (op.textAnchor) {
						const anchor = op.textAnchor;
						const block = workingBlocks.find((b) => b.ref === resolved);
						const valid =
							Number.isInteger(anchor.start) &&
							Number.isInteger(anchor.end) &&
							anchor.start >= 0 &&
							anchor.end > anchor.start &&
							typeof anchor.selectedText === "string" &&
							anchor.selectedText.length > 0 &&
							!!block &&
							anchor.end <= block.markdown.length &&
							block.markdown.slice(anchor.start, anchor.end) === anchor.selectedText;
						if (!valid) {
							return {
								ok: false,
								status: 400,
								code: "INVALID_PAYLOAD",
								message:
									"textAnchor range must match selectedText within the block's current markdown",
								snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
							};
						}
						// Mint a durable anchor rather than storing offsets as identity.
						// `textAnchor` is written too, for one release, so an older reader
						// of this sidecar still highlights the right words; the anchor is
						// what resolution uses from here on.
						const minted = anchorForRange(
							block.markdown,
							block.ref,
							anchor.start,
							anchor.end - anchor.start,
							at,
							new Set(Object.keys(workingSidecar.anchors)),
						);
						workingSidecar.anchors[minted.id] = minted;
						comment.anchorId = minted.id;
						comment.textAnchor = {
							start: anchor.start,
							end: anchor.end,
							selectedText: anchor.selectedText,
							baseMarkdown: anchor.baseMarkdown ?? block.markdown,
						};
					} else {
						// No selection: the comment covers its block. Anchoring it is what
						// lets the highlight follow the block instead of dying with its ref.
						const block = workingBlocks.find((b) => b.ref === resolved);
						if (block) {
							const minted = anchorForBlock(
								block.markdown,
								block.ref,
								at,
								new Set(Object.keys(workingSidecar.anchors)),
							);
							workingSidecar.anchors[minted.id] = minted;
							comment.anchorId = minted.id;
						}
					}
					if (op.kind === "instruction") {
						comment.kind = "instruction";
						comment.instructionState = "draft";
						if (op.fromCommentId) comment.fromCommentId = op.fromCommentId;
					}
					workingSidecar.comments.push(comment);
					workingEvents.push({
						type: "comment.added",
						at,
						by,
						commentId: comment.id,
						ref: resolved,
						text: op.text,
						kind: comment.kind,
						...(comment.textAnchor ? { textAnchor: comment.textAnchor } : {}),
					});
					break;
				}

				case "comment.mark": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					comment.instructionState = op.instructionState;
					if (op.runId !== undefined) comment.runId = op.runId;
					workingEvents.push({
						type: "comment.marked",
						at,
						by,
						commentId: op.commentId,
						instructionState: op.instructionState,
						runId: op.runId,
					});
					break;
				}

				case "comment.reply": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					comment.turns.push({ by, text: op.text, at });
					workingEvents.push({ type: "comment.replied", at, by, commentId: op.commentId, text: op.text });
					break;
				}

				case "comment.edit": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment || comment.turns.length === 0) {
						return { ok: false, status: 409, code: "COMMENT_NOT_FOUND", message: `Comment "${op.commentId}" not found.`, snapshot: buildSnapshot(mdPath, [], workingSidecar) };
					}
					comment.turns[0].text = op.text;
					workingEvents.push({ type: "comment.edited", at, by, commentId: op.commentId, text: op.text });
					break;
				}
				case "comment.delete": {
					const commentIdx = workingSidecar.comments.findIndex((c) => c.id === op.commentId);
					if (commentIdx === -1) {
						return { ok: false, status: 409, code: "COMMENT_NOT_FOUND", message: `Comment "${op.commentId}" not found.`, snapshot: buildSnapshot(mdPath, [], workingSidecar) };
					}
					workingSidecar.comments.splice(commentIdx, 1);
					workingEvents.push({ type: "comment.deleted", at, by, commentId: op.commentId });
					break;
				}
				case "comment.resolve": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					comment.resolved = true;
					workingEvents.push({ type: "comment.resolved", at, by, commentId: op.commentId });
					break;
				}

				case "comment.reopen": {
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					comment.resolved = false;
					workingEvents.push({ type: "comment.reopened", at, by, commentId: op.commentId });
					break;
				}

				case "comment.reanchor": {
					// Phase 6 / DoD #6: THE RESET SITE FOR `stale`.
					//
					// markOrphanedRefsStale() latches stale=true on an external edit.
					// Before this op there was no path back for a block-ref comment —
					// the two un-stale sites in reconcileTextCommentAnchors are
					// reachable only via lineAnchor — so an orphaned annotation was
					// permanently invisible with no signal. Recovery is possible now
					// because the anchor carries selectedText to search for.
					const comment = workingSidecar.comments.find((c) => c.id === op.commentId);
					if (!comment) {
						return {
							ok: false,
							status: 409,
							code: "COMMENT_NOT_FOUND",
							message: `Comment "${op.commentId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const reanchorRefs = currentRefs();
					const targetRef = resolveRef(workingSidecar, op.ref, reanchorRefs);
					if (!targetRef) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					// Same boundary validation as comment.add: the re-minted offsets
					// must reproduce the anchored text in the block's CURRENT markdown.
					const reanchorBlock = workingBlocks.find((b) => b.ref === targetRef);
					const anchor = op.textAnchor;
					const anchorValid =
						Number.isInteger(anchor.start) &&
						Number.isInteger(anchor.end) &&
						anchor.start >= 0 &&
						anchor.end > anchor.start &&
						typeof anchor.selectedText === "string" &&
						anchor.selectedText.length > 0 &&
						!!reanchorBlock &&
						anchor.end <= reanchorBlock.markdown.length &&
						reanchorBlock.markdown.slice(anchor.start, anchor.end) === anchor.selectedText;
					if (!anchorValid) {
						return {
							ok: false,
							status: 400,
							code: "INVALID_PAYLOAD",
							message:
								"textAnchor range must match selectedText within the block's current markdown",
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					comment.ref = targetRef;
					comment.textAnchor = {
						start: anchor.start,
						end: anchor.end,
						selectedText: anchor.selectedText,
						baseMarkdown: anchor.baseMarkdown ?? reanchorBlock.markdown,
					};
					// Clear the latch — this is the site that did not exist before.
					delete comment.stale;
					workingEvents.push({
						type: "comment.reanchored",
						at,
						by,
						commentId: comment.id,
						ref: targetRef,
						textAnchor: comment.textAnchor,
					});
					break;
				}

				case "suggestion.add": {
					const refs = currentRefs();
					const resolved = resolveRef(workingSidecar, op.ref, refs);
					if (!resolved) {
						return {
							ok: false,
							status: 409,
							code: "BLOCK_NOT_FOUND",
							message: `Block ref "${op.ref}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}

					// A suggestion gets an anchor too. This is the half that made typed
					// runs vanish: a suggestion carried only a content-derived `ref`, so
					// the moment its block's text changed the ref died and the pending
					// suggestion could no longer be placed. `quote` is sliced from the
					// block at the range it replaces, which is the only honest record of
					// what it was about.
					const anchorBlock = workingBlocks.find((b) => b.ref === resolved);
					let anchorId: string | undefined;
					if (anchorBlock) {
						const start = op.range?.start ?? 0;
						const end = op.range?.end ?? start;
						const used = new Set(Object.keys(workingSidecar.anchors));
						const minted =
							end > start
								? anchorForRange(anchorBlock.markdown, anchorBlock.ref, start, end - start, at, used)
								: anchorForBlock(anchorBlock.markdown, anchorBlock.ref, at, used);
						workingSidecar.anchors[minted.id] = minted;
						anchorId = minted.id;
					}

					const suggestion: Suggestion = {
						id: shortId("s"),
						ref: resolved,
						anchorId,
						kind: op.kind,
						status: "pending",
						by,
						markdown: op.markdown,
						range: op.range,
						baseMarkdown: op.baseMarkdown,
						basis: op.basis as Suggestion["basis"],
						basisDetail: op.basisDetail,
						createdAt: at,
					};

					if (op.status === "accepted") {
						// Apply immediately
						suggestion.status = "accepted";
						suggestion.resolvedAt = at;
						suggestion.resolvedBy = by;
						workingSidecar.archivedSuggestions.push(suggestion);
						workingEvents.push({ type: "suggestion.added", at, by, suggestionId: suggestion.id });
						workingEvents.push({ type: "suggestion.accepted", at, by, suggestionId: suggestion.id });
						// Apply as block op inline
						const inlineOp: Op = op.kind === "replace"
							? { type: "block.replace", ref: resolved, markdown: op.markdown ?? "" }
							: op.kind === "insertAfter"
							? { type: "block.insertAfter", ref: resolved, markdown: op.markdown ?? "" }
							: op.kind === "insertBefore"
							? { type: "block.insertBefore", ref: resolved, markdown: op.markdown ?? "" }
							: { type: "block.delete", ref: resolved };
						// Recursively handle by pushing to ops (not safe for complex cases, do inline)
						// For simplicity, fall through to apply the block op directly
						ops.push(inlineOp);
					} else {
						workingSidecar.suggestions.push(suggestion);
						workingEvents.push({ type: "suggestion.added", at, by, suggestionId: suggestion.id });
					}
					break;
				}

				case "suggestion.edit": {
					const staleEdit = refuseStaleSuggestion(
						workingSidecar,
						mdPath,
						workingBlocks,
						op.suggestionId,
					);
					if (staleEdit) return staleEdit;
					const sug = workingSidecar.suggestions.find((s) => s.id === op.suggestionId);
					if (!sug || sug.status !== "pending") {
						return { ok: false, status: 409, code: "SUGGESTION_NOT_FOUND", message: `Suggestion "${op.suggestionId}" not found or is no longer pending.`, snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar) };
					}
					if (op.kind !== undefined) sug.kind = op.kind;
					if (op.markdown !== undefined) sug.markdown = op.markdown;
					if (op.range !== undefined) sug.range = op.range;
					workingEvents.push({ type: "suggestion.edited", at, by, suggestionId: op.suggestionId, kind: op.kind, markdown: op.markdown, range: op.range });
					break;
				}
				case "suggestion.delete": {
					const staleDel = refuseStaleSuggestion(
						workingSidecar,
						mdPath,
						workingBlocks,
						op.suggestionId,
					);
					if (staleDel) return staleDel;
					const sugIdx = workingSidecar.suggestions.findIndex((s) => s.id === op.suggestionId);
					if (sugIdx === -1 || workingSidecar.suggestions[sugIdx].status !== "pending") {
						return { ok: false, status: 409, code: "SUGGESTION_NOT_FOUND", message: `Suggestion "${op.suggestionId}" not found or is no longer pending.`, snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar) };
					}
					workingSidecar.suggestions.splice(sugIdx, 1);
					workingEvents.push({ type: "suggestion.deleted", at, by, suggestionId: op.suggestionId });
					break;
				}
				case "suggestion.accept": {
					const staleAccept = refuseStaleSuggestion(
						workingSidecar,
						mdPath,
						workingBlocks,
						op.suggestionId,
					);
					if (staleAccept) return staleAccept;
					const sugIdx = workingSidecar.suggestions.findIndex((s) => s.id === op.suggestionId);
					if (sugIdx === -1) {
						return {
							ok: false,
							status: 409,
							code: "SUGGESTION_NOT_FOUND",
							message: `Suggestion "${op.suggestionId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const sug = workingSidecar.suggestions[sugIdx];
					let acceptedMarkdown = sug.markdown ?? "";
					if (sug.range && sug.baseMarkdown !== undefined) {
						const blockIdx = findBlockIndex(sug.ref, sug.anchorId);
						if (blockIdx !== -1) {
							const currentMarkdown = workingBlocks[blockIdx].markdown;
							if (currentMarkdown !== sug.baseMarkdown) {
								const merged = mergeBlock(sug.baseMarkdown, acceptedMarkdown, currentMarkdown);
								if (!merged.ok) {
									return {
										ok: false,
										status: 409,
										code: "STALE_REVISION",
										message: "Suggestion conflicts with a concurrent block edit.",
										snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
									};
								}
								acceptedMarkdown = merged.merged;
							}
						}
					}
					sug.status = "accepted";
					sug.resolvedAt = at;
					sug.resolvedBy = by;
					workingSidecar.suggestions.splice(sugIdx, 1);
					workingSidecar.archivedSuggestions.push(sug);

					// Supersede other pending suggestions for the same ref
					const toSupersede = workingSidecar.suggestions.filter(
						(s) => s.ref === sug.ref && s.status === "pending",
					);
					for (const other of toSupersede) {
						other.status = "rejected";
						other.resolvedAt = at;
						other.resolvedBy = "system";
						workingSidecar.suggestions.splice(workingSidecar.suggestions.indexOf(other), 1);
						workingSidecar.archivedSuggestions.push(other);
						workingEvents.push({
							type: "suggestion.rejected",
							at,
							by: "system",
							suggestionId: other.id,
							reason: "superseded",
						});
					}

					// Apply as block op.
					//
					// A typed run (`insert`/`remove`) is spliced into the block's own
					// markdown at its recorded range, rather than replacing or deleting
					// the block. This is where a typed insertion was being LOST: the
					// chain below used to end in an unguarded `block.delete`, so a kind
					// it did not recognise — `insert`, which is what Suggesting mode
					// records — deleted the entire paragraph the user had just added
					// words to. The `default` arm now refuses instead of guessing.
					const applyOp: Op | null = sug.kind === "replace"
						? { type: "block.replace", ref: sug.ref, markdown: acceptedMarkdown }
						: sug.kind === "insertAfter"
						? { type: "block.insertAfter", ref: sug.ref, markdown: sug.markdown ?? "" }
						: sug.kind === "insertBefore"
						? { type: "block.insertBefore", ref: sug.ref, markdown: sug.markdown ?? "" }
						: sug.kind === "insert" || sug.kind === "remove"
						? (() => {
								// Both need the range: without it there is nowhere to splice the
								// text, and accepting would have to guess where it belonged.
								if (!sug.range) return null;
								const blockIdx = findBlockIndex(sug.ref, sug.anchorId);
								if (blockIdx === -1) return null;
								const base = workingBlocks[blockIdx].markdown;
								const spliced =
									sug.kind === "insert"
										? base.slice(0, sug.range.start) + (sug.markdown ?? "") + base.slice(sug.range.start)
										: base.slice(0, sug.range.start) + base.slice(sug.range.end);
								return { type: "block.replace" as const, ref: sug.ref, markdown: spliced };
							})()
						: sug.kind === "delete"
						? { type: "block.delete", ref: sug.ref }
						: null;

					if (!applyOp) {
						return {
							ok: false,
							status: 400,
							code: "SUGGESTION_UNPLACEABLE",
							message:
								`Suggestion "${op.suggestionId}" (kind "${sug.kind}") cannot be placed: ` +
								`${sug.range ? "its block was not found" : "it carries no range"}. ` +
								`Refusing rather than applying it in the wrong place.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					ops.push(applyOp);
					workingEvents.push({ type: "suggestion.accepted", at, by, suggestionId: op.suggestionId });
					break;
				}

				case "suggestion.reject": {
					const staleReject = refuseStaleSuggestion(
						workingSidecar,
						mdPath,
						workingBlocks,
						op.suggestionId,
					);
					if (staleReject) return staleReject;
					const sugIdx = workingSidecar.suggestions.findIndex((s) => s.id === op.suggestionId);
					if (sugIdx === -1) {
						return {
							ok: false,
							status: 409,
							code: "SUGGESTION_NOT_FOUND",
							message: `Suggestion "${op.suggestionId}" not found.`,
							snapshot: buildSnapshot(mdPath, workingBlocks, workingSidecar),
						};
					}
					const sug = workingSidecar.suggestions[sugIdx];
					sug.status = "rejected";
					sug.resolvedAt = at;
					sug.resolvedBy = by;
					workingSidecar.suggestions.splice(sugIdx, 1);
					workingSidecar.archivedSuggestions.push(sug);
					workingEvents.push({ type: "suggestion.rejected", at, by, suggestionId: op.suggestionId });
					break;
				}

				default:
					return { ok: false, status: 400, code: "INVALID_PAYLOAD", message: "Unknown op type" };
			}
		}

		// Rebuild final markdown from working nodes
		const newMarkdown = blocksToMarkdown(workingNodes);
		const newFingerprint = sha256file(newMarkdown);

		// Recompute refMap and aliases
		const reparsedNodes = parseBlocks(newMarkdown);
		const { blocks: finalBlocks, newRefMap: finalRefMap } = assignRefs(reparsedNodes, workingSidecar);

		const oldHashToRef = new Map<string, string>();
		for (const [ref, entry] of Object.entries(workingSidecar.refMap)) {
			if (!oldHashToRef.has(entry.textHash)) oldHashToRef.set(entry.textHash, ref);
		}
		// The pre-edit ordering. `workingSidecar.refMap` is keyed in document order as
		// written by `assignRefs`, so it describes the blocks as they stood before this
		// op — the information needed to alias a block that was edited in place rather
		// than moved. Without it every annotation on an edited block was orphaned.
		const { refAliases } = computeRefDelta(workingSidecar.refMap, oldHashToRef, finalBlocks);
		Object.assign(collectedAliases, refAliases);

		// The revision is a CONTENT baseline. Annotation-only ops (comment.add /
		// comment.mark / resolve / reopen) leave the document text unchanged, so they
		// must not bump it — otherwise dispatching an instruction (which writes a
		// comment then marks it sent) invalidates the very baseRevision the agent was
		// handed, and every follow-up block edit fails closed as STALE_REVISION.
		const contentChanged = newFingerprint !== fingerprint;
		if (contentChanged) workingSidecar.revision += 1;
		workingSidecar.updatedAt = nowIso();
		workingSidecar.fingerprint = newFingerprint;
		workingSidecar.refMap = finalRefMap;
		workingSidecar.refAliases = collectedAliases;

		// Emit all collected events
		const emitted = emitEvents(workingSidecar, workingEvents);

		// Trim if needed
		if (workingSidecar.revision % SIDECAR_TRIM_EVERY_N_MUTATIONS === 0) {
			trimEvents(workingSidecar, SIDECAR_EVENT_TRIM_SIZE);
		}

		// Write the .md only when its content actually changed.
		//
		// This used to be unconditional, and the cost was not a wasted write: touching the
		// file bumps its mtime, chokidar reports the change, and the client watching its own
		// open document treats that as an external edit — reloading the snapshot and the
		// sidecar, and in view mode reloading the page. A comment or a suggestion does not
		// alter the markdown (`contentChanged` is false), yet every such op rewrote the file,
		// so EVERY keystroke in Suggesting mode refreshed the whole document under the user's
		// cursor. That is the glitch this fixes.
		//
		// It also keeps the file's mtime honest: it moves only when the bytes move.
		if (contentChanged) {
			await writeFile(path.join(rootDir, mdPath), newMarkdown, "utf-8");
		}
		await writeSidecar(rootDir, mdPath, workingSidecar);

		return {
			ok: true,
			snapshot: buildSnapshot(mdPath, finalBlocks, workingSidecar),
			emittedEvents: emitted,
		};
	});
}
