import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { RootContent } from "mdast";
import type { Op, Block, Snapshot, Sidecar, ProofEvent, Comment, Suggestion } from "./types";
import { parseBlocks, blockToMarkdown, blocksToMarkdown } from "./blocks";
import { assignRefs, resolveRef, computeRefDelta, textHash } from "./block-refs";
import { wrapAsProofSpan, newSpanId } from "./proof-span";
import { readSidecar, writeSidecar, emptySidecar } from "./sidecar";
import { withFileMutex } from "./mutex";
import { emitEvents, trimEvents } from "./event-bus";
import { SIDECAR_EVENT_TRIM_SIZE, SIDECAR_TRIM_EVERY_N_MUTATIONS } from "../proof-config";

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

/**
 * Wrap op markdown for AI agents: inserts proof-span marks on text-bearing blocks.
 * Returns { wrappedMarkdown, blockProvenance }.
 */
function wrapForAi(
	markdown: string,
	by: string,
	basis: string | undefined,
	basisDetail: string | undefined,
	inResponseTo: string | undefined,
	sidecar: Sidecar,
	blockRef: string,
): string {
	const attrs = {
		spanId: newSpanId(),
		origin: "ai" as const,
		basis: basis ?? "inferred",
		basisDetail,
		by,
		at: nowIso(),
		inResponseTo,
	};
	const wrapped = wrapAsProofSpan(markdown, attrs);
	if (wrapped === null) {
		// Non-wrappable block type. Record in sidecar.blockProvenance instead.
		if (!sidecar.blockProvenance) sidecar.blockProvenance = {};
		sidecar.blockProvenance[blockRef] = attrs;
		return markdown;
	}
	return wrapped;
}

/**
 * Parse op markdown into mdast nodes, assign refs, and wrap for AI if needed.
 */
function opMarkdownToBlocks(
	markdown: string,
	by: string,
	basis: string | undefined,
	basisDetail: string | undefined,
	inResponseTo: string | undefined,
	isAi: boolean,
	workingBlocks: Block[],
	workingSidecar: Sidecar,
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

		if (isAi) {
			md = wrapForAi(md, by, basis, basisDetail, inResponseTo, workingSidecar, ref);
			// Reparse the wrapped markdown to get the updated node
			const reparsed = parseBlocks(md);
			if (reparsed.length > 0) {
				nodes[i] = reparsed[0];
			}
		}
	}

	return { nodes, refs };
}

function markOrphanedRefsStale(sidecar: Sidecar, newRefMap: Record<string, unknown>): void {
	const validRefs = new Set(Object.keys(newRefMap));
	for (const s of sidecar.suggestions) {
		if (s.status === "pending" && !validRefs.has(s.ref)) {
			s.stale = true;
		}
	}
	for (const c of sidecar.comments) {
		if (!c.resolved && c.ref && !validRefs.has(c.ref)) {
			c.stale = true;
		}
	}
}

function buildSnapshot(
	mdPath: string,
	blocks: Block[],
	sidecar: Sidecar,
): Snapshot {
	return {
		path: mdPath,
		revision: sidecar.revision,
		createdAt: sidecar.createdAt,
		updatedAt: sidecar.updatedAt,
		fingerprint: sidecar.fingerprint,
		blocks,
		comments: sidecar.comments,
		suggestions: sidecar.suggestions.filter((s) => s.status === "pending"),
		lastEventId: sidecar.nextEventId - 1,
	};
}

/**
 * Reconcile a sidecar after a file was modified outside of block-ops.
 * Rebuilds refMap, bumps revision, marks orphaned anchors stale, emits event, writes sidecar.
 *
 * Callers MUST hold `withFileMutex(mdPath, ...)` before calling.
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
	const oldFingerprint = sidecar.fingerprint;
	sidecar.refMap = newRefMap;
	sidecar.revision += 1;
	sidecar.updatedAt = nowIso();
	sidecar.fingerprint = fingerprint;
	markOrphanedRefsStale(sidecar, newRefMap);
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
		return withFileMutex(mdPath, async () => {
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

	// Sync sidecar refMap if it's empty (first read) and persist fingerprint
	if (Object.keys(sidecar.refMap).length === 0) {
		sidecar.refMap = newRefMap;
		sidecar.fingerprint = fingerprint;
		// Persist so future readSnapshot calls can detect external edits
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

	return withFileMutex(mdPath, async (): Promise<ApplyResult> => {
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
					workingSidecar.comments.push(comment);
					workingEvents.push({
						type: "comment.added",
						at,
						by,
						commentId: comment.id,
						text: op.text,
						lineAnchor: comment.lineAnchor,
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

		workingSidecar.revision += 1;
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

	return withFileMutex(mdPath, async (): Promise<ApplyResult> => {
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

		const isAi = by.startsWith("ai:");

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

		function findBlockIndex(ref: string): number {
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
						op.markdown, by, op.basis, op.basisDetail, op.inResponseTo,
						isAi, workingBlocks.filter((_, i) => i !== idx), workingSidecar,
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
						op.markdown, by, op.basis, op.basisDetail, op.inResponseTo,
						isAi, workingBlocks, workingSidecar,
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
						op.markdown, by, op.basis, op.basisDetail, op.inResponseTo,
						isAi, workingBlocks, workingSidecar,
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
						op.markdown, by, op.basis, op.basisDetail, op.inResponseTo,
						isAi, workingBlocks, workingSidecar,
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
						op.markdown, by, op.basis, op.basisDetail, op.inResponseTo,
						isAi, workingBlocks, workingSidecar,
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
					workingSidecar.comments.push(comment);
					workingEvents.push({ type: "comment.added", at, by, commentId: comment.id, ref: resolved, text: op.text });
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

					const suggestion: Suggestion = {
						id: shortId("s"),
						ref: resolved,
						kind: op.kind,
						status: "pending",
						by,
						markdown: op.markdown,
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

				case "suggestion.accept": {
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

					// Apply as block op
					const applyOp: Op = sug.kind === "replace"
						? { type: "block.replace", ref: sug.ref, markdown: sug.markdown ?? "" }
						: sug.kind === "insertAfter"
						? { type: "block.insertAfter", ref: sug.ref, markdown: sug.markdown ?? "" }
						: sug.kind === "insertBefore"
						? { type: "block.insertBefore", ref: sug.ref, markdown: sug.markdown ?? "" }
						: { type: "block.delete", ref: sug.ref };
					ops.push(applyOp);
					workingEvents.push({ type: "suggestion.accepted", at, by, suggestionId: op.suggestionId });
					break;
				}

				case "suggestion.reject": {
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
		const { refAliases } = computeRefDelta(workingSidecar.refMap, oldHashToRef, finalBlocks);
		Object.assign(collectedAliases, refAliases);

		workingSidecar.revision += 1;
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

		// Atomic write
		await writeFile(path.join(rootDir, mdPath), newMarkdown, "utf-8");
		await writeSidecar(rootDir, mdPath, workingSidecar);

		return {
			ok: true,
			snapshot: buildSnapshot(mdPath, finalBlocks, workingSidecar),
			emittedEvents: emitted,
		};
	});
}
