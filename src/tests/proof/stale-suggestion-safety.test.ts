/**
 * Accepting an orphaned suggestion must fail loudly, not write a phantom change.
 *
 * Suggestions whose block is gone are latched `stale = true` and filtered out of the
 * pending set, so no UI offers to accept one. The agent API can still address one by id,
 * which is the risk worth pinning: a suggestion whose text no longer exists must not be
 * able to inject its markdown into the document.
 *
 * It is safe, and the mechanism is not obvious from the accept case alone. Accept does
 * not apply anything directly. It marks the suggestion accepted, archives it, and
 * RE-EMITS it as a block op (`block.replace`/`insertAfter`/`insertBefore`/`delete` on
 * `sug.ref`) which is pushed back onto the same op list and applied on a later pass.
 * An orphaned suggestion therefore becomes a block op naming a ref that does not exist,
 * and the ordinary `BLOCK_NOT_FOUND` guard rejects the whole call.
 *
 * This test exists because that indirection reads like a bug — the accept case appears
 * to have no guard of its own — and someone could "simplify" it into one that writes
 * `sug.markdown` directly.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { applyOps } from "@/lib/proof/ops-applier";
import { createHash } from "node:crypto";
import { assignRefs } from "@/lib/proof/block-refs";
import { parseBlocks } from "@/lib/proof/blocks";
import { emptySidecar, readSidecar, writeSidecar } from "@/lib/proof/sidecar";
import type { Suggestion } from "@/lib/proof/types";

const CONTENT = "Alpha paragraph.\n\nBeta paragraph.\n";

async function seedWithDeadSuggestion() {
	const root = await mkdtemp(path.join(tmpdir(), "stale-sug-"));
	const mdPath = "s.md";
	await writeFile(path.join(root, mdPath), CONTENT, "utf8");
	const sc = emptySidecar(mdPath);
	sc.suggestions.push({
		id: "sug-dead",
		ref: "bDEAD",
		status: "pending",
		stale: true,
		kind: "replace",
		markdown: "PHANTOM REPLACEMENT",
		createdAt: new Date().toISOString(),
		by: "human",
	} as unknown as Suggestion);
	await writeSidecar(root, mdPath, sc);
	return { root, mdPath, revision: sc.revision };
}

describe("an orphaned suggestion cannot write into the document", () => {
	test("accepting it is refused", async () => {
		const { root, mdPath, revision } = await seedWithDeadSuggestion();
		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-dead" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, false, "the accept must not succeed");
		// The refusal now comes from the stale guard, which runs BEFORE the block
		// lookup. The dead ref would also have been caught later by BLOCK_NOT_FOUND,
		// but the honest reason is that the suggestion is stale — and unlike the
		// block lookup, the stale guard also covers the reachable case where the ref
		// resolves again.
		assert.equal(res.code, "SUGGESTION_STALE", "and must say why");
	});

	test("the file is untouched", async () => {
		const { root, mdPath, revision } = await seedWithDeadSuggestion();
		await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-dead" }],
		} as never);
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.equal(onDisk, CONTENT, "no phantom markdown reached the file");
		assert.ok(!onDisk.includes("PHANTOM"), "specifically not the suggestion's text");
	});

	test("the suggestion is neither consumed nor archived", async () => {
		// A refused accept must leave the sidecar as it was, so the caller can retry
		// after the text is restored rather than finding the suggestion silently gone.
		const { root, mdPath, revision } = await seedWithDeadSuggestion();
		await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-dead" }],
		} as never);
		const sc = await readSidecar(root, mdPath);
		assert.deepEqual(
			(sc?.suggestions ?? []).map((s) => s.id),
			["sug-dead"],
			"still pending",
		);
		assert.deepEqual(sc?.archivedSuggestions ?? [], [], "nothing archived");
	});

	test("CONTROL: accepting a LIVE suggestion does change the file", async () => {
		// Without this the cases above could pass because acceptance is broken for every
		// suggestion, which would look identical from the outside. Here the ref is real,
		// so the same call must succeed.
		const root = await mkdtemp(path.join(tmpdir(), "live-sug-"));
		const mdPath = "s.md";
		await writeFile(path.join(root, mdPath), CONTENT, "utf8");

		// Learn the refs the document actually mints, and seed the sidecar with them
		// rather than guessing a ref name.
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);
		assert.ok(refs.length >= 1, "expected the document to mint at least one ref");

		const sc = emptySidecar(mdPath);
		sc.refMap = newRefMap;
		sc.fingerprint = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
		sc.suggestions.push({
			id: "sug-live",
			ref: refs[0],
			status: "pending",
			kind: "replace",
			markdown: "REPLACED FOR REAL",
			createdAt: new Date().toISOString(),
			by: "human",
		} as unknown as Suggestion);
		await writeSidecar(root, mdPath, sc);

		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: sc.revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-live" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, true, `a live accept must succeed, got ${res.code}`);
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.match(onDisk, /REPLACED FOR REAL/, "and its markdown reaches the file");
	});
});

describe("a stale suggestion cannot be accepted once its anchor comes back", () => {
	/**
	 * The reachable case the first version of this file missed.
	 *
	 * Refs are content-derived, so deleting a block and typing the same text again
	 * makes the original ref valid a second time — while `stale` stays true, because
	 * `markOrphanedRefsStale` only ever sets it. The UI keeps filtering the
	 * suggestion out, so the user cannot see it, but the ref now resolves, which
	 * means the ordinary BLOCK_NOT_FOUND guard no longer refuses anything.
	 *
	 * The earlier tests only covered a ref that can NEVER resolve (`bDEAD`). That
	 * proved a dead suggestion cannot be accepted; it did not prove a stale one
	 * cannot. The distinction matters because only the second is reachable by
	 * normal editing.
	 */
	async function seedStaleWithLiveRef() {
		const root = await mkdtemp(path.join(tmpdir(), "stale-live-"));
		const mdPath = "s.md";
		// The block exists, so every ref resolves normally.
		await writeFile(path.join(root, mdPath), CONTENT, "utf8");
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);

		const sc = emptySidecar(mdPath);
		sc.refMap = newRefMap;
		sc.fingerprint = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
		sc.suggestions.push({
			id: "sug-stale-live",
			ref: refs[0],
			status: "pending",
			// The state reconciliation leaves behind after delete-then-retype.
			stale: true,
			kind: "replace",
			markdown: "STALE PHANTOM EDIT",
			createdAt: new Date().toISOString(),
			by: "human",
		} as unknown as Suggestion);
		await writeSidecar(root, mdPath, sc);
		return { root, mdPath, revision: sc.revision };
	}

	test("accepting a stale suggestion with a LIVE ref is refused", async () => {
		const { root, mdPath, revision } = await seedStaleWithLiveRef();
		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-stale-live" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, false, "stale is stale even when the ref resolves again");
		assert.equal(res.code, "SUGGESTION_STALE", "and the refusal names the real reason");
	});

	test("the file is untouched", async () => {
		const { root, mdPath, revision } = await seedStaleWithLiveRef();
		await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-stale-live" }],
		} as never);
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.equal(onDisk, CONTENT, "a hidden suggestion must not edit the document");
		assert.ok(!onDisk.includes("STALE PHANTOM EDIT"), "specifically not its markdown");
	});

	test("reject and delete are refused too, not just accept", async () => {
		// The guard is about the recorded state, so every mutating op must honour it.
		for (const type of ["suggestion.reject", "suggestion.delete"]) {
			const { root, mdPath, revision } = await seedStaleWithLiveRef();
			const res = (await applyOps({
				rootDir: root,
				mdPath,
				baseRevision: revision,
				by: "human",
				ops: [{ type, suggestionId: "sug-stale-live" }],
			} as never)) as unknown as { ok: boolean; code?: string };
			assert.equal(res.ok, false, `${type} must be refused on a stale suggestion`);
			assert.equal(res.code, "SUGGESTION_STALE", `${type} names the reason`);
		}
	});

	test("CONTROL: the same suggestion is accepted once stale is cleared", async () => {
		// Proves the refusal is caused by `stale` and not by the seeded ref being wrong.
		// Clearing the flag is not something production does — it stands in for the
		// explicit revive transition the API does not have yet.
		const { root, mdPath, revision } = await seedStaleWithLiveRef();
		const sc = await readSidecar(root, mdPath);
		assert.ok(sc, "sidecar must exist");
		sc.suggestions[0].stale = false;
		await writeSidecar(root, mdPath, sc);

		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: sc.revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-stale-live" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, true, `an un-stale suggestion accepts normally, got ${res.code}`);
	});
});

describe("accepting a typed insertion must not destroy its block", () => {
	/**
	 * Found live, not by reading: accepting a typed suggestion DELETED the whole
	 * paragraph it was typed into.
	 *
	 * Suggesting mode records a run of characters as `kind: "insert"`. The accept chain
	 * mapped kinds to block ops and ended in an unguarded `block.delete`, so a kind it
	 * did not enumerate — `insert` — fell through to deleting the block. The user's
	 * added words were removed along with every other word in the paragraph.
	 *
	 * Two things were wrong and both are pinned here: `insert` was not in the accept
	 * chain at all, and the fallthrough guessed instead of refusing.
	 */
	async function seedTypedInsertion(range?: { start: number; end: number }) {
		const root = await mkdtemp(path.join(tmpdir(), "typed-ins-"));
		const mdPath = "s.md";
		await writeFile(path.join(root, mdPath), CONTENT, "utf8");
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);

		const sc = emptySidecar(mdPath);
		sc.refMap = newRefMap;
		sc.fingerprint = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
		sc.suggestions.push({
			id: "sug-typed",
			ref: refs[0],
			status: "pending",
			kind: "insert",
			markdown: "XYZ",
			range,
			createdAt: new Date().toISOString(),
			by: "human",
		} as unknown as Suggestion);
		await writeSidecar(root, mdPath, sc);
		return { root, mdPath, revision: sc.revision };
	}

	test("the paragraph survives, with the typed text spliced in", async () => {
		// "Alpha paragraph." is 16 characters, so offset 16 is the end of the block.
		const { root, mdPath, revision } = await seedTypedInsertion({ start: 16, end: 16 });
		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-typed" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, true, `accept must succeed, got ${res.code}`);
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.match(onDisk, /Alpha paragraph\./, "the commented block must still exist");
		assert.match(onDisk, /XYZ/, "and carry the accepted text");
		assert.match(onDisk, /Beta paragraph\./, "and leave its neighbour alone");
	});

	test("the text lands at the recorded offset, not at the block's start", async () => {
		// Offset 5 is between "Alpha" and " paragraph." — splicing at 0 instead would
		// still pass a "contains XYZ" check while placing it in the wrong place.
		const { root, mdPath, revision } = await seedTypedInsertion({ start: 5, end: 5 });
		await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-typed" }],
		} as never);
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.match(onDisk, /AlphaXYZ paragraph\./, "spliced at the offset, not prepended");
	});

	test("an insertion with no range is REFUSED, not guessed at", async () => {
		// The old code silently turned this into a block delete. Refusing is the only
		// safe answer: there is no offset, so any placement would be invention.
		const { root, mdPath, revision } = await seedTypedInsertion(undefined);
		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-typed" }],
		} as never)) as unknown as { ok: boolean; code?: string };

		assert.equal(res.ok, false, "must not apply");
		assert.equal(res.code, "SUGGESTION_UNPLACEABLE");
		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.equal(onDisk, CONTENT, "and must not touch the file");
	});

	test("a typed deletion removes only its range", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "typed-del-"));
		const mdPath = "s.md";
		await writeFile(path.join(root, mdPath), CONTENT, "utf8");
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);
		const sc = emptySidecar(mdPath);
		sc.refMap = newRefMap;
		sc.fingerprint = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
		sc.suggestions.push({
			id: "sug-typed-del",
			ref: refs[0],
			status: "pending",
			kind: "remove",
			markdown: "",
			range: { start: 0, end: 5 }, // "Alpha"
			createdAt: new Date().toISOString(),
			by: "human",
		} as unknown as Suggestion);
		await writeSidecar(root, mdPath, sc);

		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: sc.revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-typed-del" }],
		} as never)) as unknown as { ok: boolean; code?: string };
		assert.equal(res.ok, true, `accept must succeed, got ${res.code}`);

		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.match(onDisk, / paragraph\./, "the rest of the block survives");
		assert.doesNotMatch(onDisk, /Alpha/, "and only the range is gone");
	});

	test("CONTROL: a whole-block delete still deletes its block", async () => {
		// The `delete` kind must keep working — the fix routes `insert`/`remove`
		// separately rather than removing the whole-block branch.
		const root = await mkdtemp(path.join(tmpdir(), "blk-del-"));
		const mdPath = "s.md";
		await writeFile(path.join(root, mdPath), CONTENT, "utf8");
		const { newRefMap } = assignRefs(parseBlocks(CONTENT), null);
		const refs = Object.keys(newRefMap);
		const sc = emptySidecar(mdPath);
		sc.refMap = newRefMap;
		sc.fingerprint = `sha256:${createHash("sha256").update(CONTENT, "utf8").digest("hex")}`;
		sc.suggestions.push({
			id: "sug-blk-del",
			ref: refs[0],
			status: "pending",
			kind: "delete",
			markdown: "",
			createdAt: new Date().toISOString(),
			by: "human",
		} as unknown as Suggestion);
		await writeSidecar(root, mdPath, sc);

		const res = (await applyOps({
			rootDir: root,
			mdPath,
			baseRevision: sc.revision,
			by: "human",
			ops: [{ type: "suggestion.accept", suggestionId: "sug-blk-del" }],
		} as never)) as unknown as { ok: boolean; code?: string };
		assert.equal(res.ok, true, `accept must succeed, got ${res.code}`);

		const onDisk = await readFile(path.join(root, mdPath), "utf8");
		assert.doesNotMatch(onDisk, /Alpha paragraph\./, "the block is gone");
		assert.match(onDisk, /Beta paragraph\./, "its neighbour is not");
	});
});
