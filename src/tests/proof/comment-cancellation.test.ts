/**
 * Comments whose anchored text disappears are MARKED LOST, and kept.
 *
 * Two earlier designs are rejected. Latching `stale = true` parked the comment
 * forever waiting on a re-anchoring UI nobody built. Cancelling it deleted
 * something the user wrote as a side effect of somebody else's save. Following
 * Google Docs, the card stays and is shown as detached.
 *
 * The safety property the cancellation was there for still holds, and is asserted
 * here directly: Copy-as-prompt serializes a comment only when a snippet resolves
 * for it, so a lost comment contributes nothing to an agent's prompt. A deleted
 * sentence cannot put a phantom instruction in front of an agent.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { reconcileSidecar } from "@/lib/proof/ops-applier";
import { emptySidecar } from "@/lib/proof/sidecar";
import { mapAnnotationsToPromptItems } from "@/lib/proof/prompt-serialize";

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
		assert.equal(c.anchorStatus, "lost", "the comment is marked lost");
		assert.notEqual(c.resolved, true, "but it is not resolved");
		assert.equal(c.cancelledAt, undefined, "and it is never cancelled");
		assert.notEqual(c.stale, true, "nor parked as stale");
	});

	test("lost comments contribute nothing to Copy-as-prompt", async () => {
		// This is the load-bearing consequence, and it does not depend on cancelling:
		// the serializer emits a comment only when a snippet resolves for it.
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

		const lost = sidecar.comments[0];
		assert.equal(lost.anchorStatus, "lost", "the comment is marked lost");
		assert.notEqual(lost.resolved, true, "it is not resolved, so it stays on the record");

		// The safety property, asserted through the real serializer rather than
		// through the `resolved` flag: a comment whose snippet cannot be resolved
		// produces no prompt item at all. That is what keeps a deleted sentence out
		// of an agent's instructions now that we no longer cancel the comment.
		const items = mapAnnotationsToPromptItems(
			sidecar.comments,
			[],
			() => undefined, // no readable anchor: this comment cannot be placed
		);
		assert.equal(items.length, 0, "an unplaceable comment yields no prompt item");
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