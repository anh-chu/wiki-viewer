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
		assert.equal(res.code, "BLOCK_NOT_FOUND", "and must say why");
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
