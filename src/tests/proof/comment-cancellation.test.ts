/**
 * Comments whose anchored text disappears are CANCELLED.
 *
 * The earlier design latched `stale = true` and expected a re-anchoring UI. That
 * UI was never built, and the decision is that a comment whose text no longer
 * exists should simply go away rather than sit in a recovery queue nobody reads.
 *
 * Why this matters beyond tidiness: an orphaned comment that stays unresolved
 * still feeds Copy-as-prompt, so a deleted sentence could put a phantom
 * instruction in front of an agent. Cancelling removes it from that path.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { reconcileSidecar } from "@/lib/proof/ops-applier";
import { emptySidecar } from "@/lib/proof/sidecar";

let root = "";

before(async () => {
	root = await mkdtemp(path.join(tmpdir(), "wiki-cancel-"));
});
after(async () => {
	await rm(root, { recursive: true, force: true });
});

/** Write a doc, reconcile, and return the sidecar so refs are assigned. */
async function docWithContent(name: string, content: string) {
	const mdPath = path.join(root, name);
	await writeFile(mdPath, content, "utf8");
	const sidecar = emptySidecar(mdPath);
	await reconcileSidecar({
		rootDir: root,
		mdPath,
		content,
		sidecar,
		by: "human",
		eventType: "file.externallyEdited",
		fingerprint: "fp-1",
	});
	return { mdPath, sidecar, content };
}

describe("cancelling comments whose text is gone", () => {
	test("a comment survives an edit that keeps its text", async () => {
		const { mdPath, sidecar, content } = await docWithContent(
			"keep.md",
			"# Title\n\nWatermelon\n\nTangerine\n",
		);
		const target = sidecar.comments;
		sidecar.comments.push({
			id: "c0001",
			ref: Object.keys(sidecar.refMap)[1],
			resolved: false,
			createdAt: new Date().toISOString(),
			turns: [{ by: "human", at: new Date().toISOString(), text: "keep me" }],
		});
		assert.equal(target.length, 1);

		// Re-reconcile with the same content: the ref is still valid.
		await reconcileSidecar({
			rootDir: root,
			mdPath,
			content,
			sidecar,
			by: "human",
			eventType: "file.externallyEdited",
			fingerprint: "fp-2",
		});

		assert.equal(sidecar.comments[0].resolved, false, "still live");
		assert.equal(sidecar.comments[0].cancelledAt, undefined, "not cancelled");
	});

	test("a comment is cancelled when its block disappears", async () => {
		const initial = "# Title\n\nWatermelon\n\nTangerine\n";
		const { mdPath, sidecar } = await docWithContent("gone.md", initial);
		const refs = Object.keys(sidecar.refMap);
		sidecar.comments.push({
			id: "c0002",
			ref: refs[2],
			resolved: false,
			createdAt: new Date().toISOString(),
			turns: [{ by: "human", at: new Date().toISOString(), text: "about tangerine" }],
		});

		// Delete the commented block entirely.
		const edited = "# Title\n\nWatermelon\n";
		await writeFile(mdPath, edited, "utf8");
		await reconcileSidecar({
			rootDir: root,
			mdPath,
			content: edited,
			sidecar,
			by: "human",
			eventType: "file.externallyEdited",
			fingerprint: "fp-3",
		});

		const c = sidecar.comments[0];
		assert.equal(c.resolved, true, "cancelled comments are resolved, so they leave the margin");
		assert.equal(c.cancelReason, "anchor-lost");
		assert.ok(c.cancelledAt, "cancellation is timestamped");
		assert.notEqual(c.stale, true, "no longer parked as stale");
	});

	test("cancelled comments stop counting as pending agent work", async () => {
		// This is the load-bearing consequence: Copy-as-prompt reads unresolved
		// comments, so cancelling is what keeps a deleted sentence out of prompts.
		const initial = "# Title\n\nAlpha\n\nBeta\n";
		const { mdPath, sidecar } = await docWithContent("pending.md", initial);
		sidecar.comments.push({
			id: "c0003",
			ref: Object.keys(sidecar.refMap)[2],
			resolved: false,
			createdAt: new Date().toISOString(),
			turns: [{ by: "human", at: new Date().toISOString(), text: "do something" }],
		});

		const edited = "# Title\n\nAlpha\n";
		await writeFile(mdPath, edited, "utf8");
		await reconcileSidecar({
			rootDir: root,
			mdPath,
			content: edited,
			sidecar,
			by: "human",
			eventType: "file.externallyEdited",
			fingerprint: "fp-4",
		});

		const pending = sidecar.comments.filter((c) => !c.resolved);
		assert.equal(pending.length, 0, "nothing pending for an agent to act on");
	});

	test("an already-resolved comment is left alone", async () => {
		const initial = "# Title\n\nAlpha\n\nBeta\n";
		const { mdPath, sidecar } = await docWithContent("resolved.md", initial);
		sidecar.comments.push({
			id: "c0004",
			ref: Object.keys(sidecar.refMap)[2],
			resolved: true,
			createdAt: new Date().toISOString(),
			turns: [{ by: "human", at: new Date().toISOString(), text: "done already" }],
		});

		const edited = "# Title\n\nAlpha\n";
		await writeFile(mdPath, edited, "utf8");
		await reconcileSidecar({
			rootDir: root,
			mdPath,
			content: edited,
			sidecar,
			by: "human",
			eventType: "file.externallyEdited",
			fingerprint: "fp-5",
		});

		assert.equal(
			sidecar.comments[0].cancelReason,
			undefined,
			"a resolved comment is not retroactively cancelled",
		);
	});

	test("CONTROL: a comment on a ref that still exists is NOT cancelled", async () => {
		// Without this, the tests above would pass even if every comment were
		// cancelled unconditionally.
		const initial = "# Title\n\nAlpha\n\nBeta\n";
		const { mdPath, sidecar } = await docWithContent("control.md", initial);
		sidecar.comments.push({
			id: "c0005",
			ref: Object.keys(sidecar.refMap)[1],
			resolved: false,
			createdAt: new Date().toISOString(),
			turns: [{ by: "human", at: new Date().toISOString(), text: "on alpha" }],
		});

		const edited = "# Title\n\nAlpha\n\nGamma\n";
		await writeFile(mdPath, edited, "utf8");
		await reconcileSidecar({
			rootDir: root,
			mdPath,
			content: edited,
			sidecar,
			by: "human",
			eventType: "file.externallyEdited",
			fingerprint: "fp-6",
		});

		assert.equal(sidecar.comments[0].resolved, false, "the untouched comment stays live");
	});
});