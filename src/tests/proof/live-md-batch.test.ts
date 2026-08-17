/**
 * Batch markdown Tweak dispatch — reuses the shared live store + md-proposal
 * store. A single /api/wiki/live/request batch (kind "generate") that carries
 * md-surface items (string blockRef + numeric baseRevision) creates one md
 * proposal per item with a server-computed baseBlockHash, enqueues ONE
 * outstanding request, and lets each item resolve through the unchanged
 * md-resolve route keyed by previewId.
 */
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestWorkspace, makeFile } from "./helpers/workspace.js";
import { readSnapshot } from "../../lib/proof/ops-applier.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { getProposal } from "../../lib/proof/live/md-proposal-store.js";
import * as mdStore from "../../lib/proof/live/md-proposal-store.js";
import * as store from "../../lib/proof/live/store.js";

let wsA: string;
let rootA: string;
let mutateToken: string;
let requestPOST: (req: Request) => Promise<Response>;
let mdPreviewPOST: (req: Request) => Promise<Response>;
let mdResolvePOST: (req: Request) => Promise<Response>;

const filePath = "batch.md";
const original = "# Title\n\nFirst paragraph.\n\nSecond paragraph.\n";

function userUrl(route: string, ws: string, params: Record<string, string> = {}): string {
	const u = new URL(`http://localhost:3000${route}`);
	u.searchParams.set("ws", ws);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
}

function agentHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${mutateToken}`,
		"X-Agent-Id": "ai:md-batch-agent",
		"Content-Type": "application/json",
	};
}

function canonicalHash(markdown: string): string {
	return `sha256:${createHash("sha256").update(markdown, "utf8").digest("hex")}`;
}

async function paragraphs() {
	const snapshot = await readSnapshot(rootA, filePath);
	assert.ok(snapshot);
	const blocks = snapshot.blocks.filter((b) => b.type === "paragraph");
	assert.ok(blocks.length >= 2);
	return { snapshot, blockA: blocks[0], blockB: blocks[1] };
}

async function dispatchBatch(ws = wsA) {
	const { snapshot, blockA, blockB } = await paragraphs();
	const res = await requestPOST(
		new Request(userUrl("/api/wiki/live/request", ws), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				path: filePath,
				kind: "generate",
				items: [
					{
						instructionId: "i1",
						blockRef: blockA.ref,
						baseRevision: snapshot.revision,
						instruction: "Rewrite first",
					},
					{
						instructionId: "i2",
						blockRef: blockB.ref,
						baseRevision: snapshot.revision,
						instruction: "Rewrite second",
					},
				],
			}),
		}),
	);
	return { res, snapshot, blockA, blockB };
}

async function submitPreviews(
	requestId: string,
	entries: Array<{ previewId: string; variants: Array<{ variantId: string; label: string; markdown: string }> }>,
) {
	return mdPreviewPOST(
		new Request(userUrl("/api/agent/live/md-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({ requestId, itemPreviews: entries }),
		}),
	);
}

before(async () => {
	process.env.HOME = await mkdtemp(path.join(tmpdir(), "md-batch-home-"));
	process.env.WIKI_NO_AUTH = "1";
	const a = await createTestWorkspace({ name: "md-batch-a" });
	wsA = a.workspace.id;
	rootA = a.rootDir;
	await makeFile(rootA, filePath, original);
	await ensureRegistry();
	mutateToken = randomBytes(32).toString("hex");
	await addAgent({
		id: "ai:md-batch-agent",
		displayName: "MD Batch Agent",
		tokenHash: hashToken(mutateToken),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});
	requestPOST = (await import("../../app/api/wiki/live/request/route.js")).POST;
	mdPreviewPOST = (await import("../../app/api/agent/live/md-preview/route.js")).POST;
	mdResolvePOST = (await import("../../app/api/wiki/live/md-resolve/route.js")).POST;
	store._resetForTests();
	mdStore._resetForTests();
});

after(async () => {
	store._resetForTests();
	mdStore._resetForTests();
	await rm(process.env.HOME!, { recursive: true, force: true });
	delete process.env.WIKI_NO_AUTH;
});

beforeEach(async () => {
	// live.db is a file shared by both stores; closing the singleton is not
	// enough — remove the db so each scenario starts with no rows.
	store._resetForTests();
	mdStore._resetForTests();
	for (const suffix of ["", "-wal", "-shm"]) {
		await rm(path.join(process.env.HOME!, ".wiki-viewer", `live.db${suffix}`), {
			force: true,
		});
	}
	await writeFile(path.join(rootA, filePath), original);
});

test("batch dispatch creates one outstanding request; second returns 409", async () => {
	const { res, blockA, blockB } = await dispatchBatch();
	assert.equal(res.status, 200);
	const body = (await res.json()) as {
		ok: boolean;
		requestId: string;
		items: Array<{ instructionId: string; previewId: string }>;
	};
	assert.equal(body.items.length, 2);
	for (const it of body.items) assert.equal(typeof it.previewId, "string");

	const pA = getProposal(body.items[0].previewId)!;
	const pB = getProposal(body.items[1].previewId)!;
	assert.equal(pA.state, "requested");
	assert.equal(pB.state, "requested");
	assert.equal(pA.baseBlockHash, canonicalHash(blockA.markdown));
	assert.equal(pB.baseBlockHash, canonicalHash(blockB.markdown));

	// Second dispatch while outstanding → 409 OUTSTANDING_REQUEST.
	const { res: res2 } = await dispatchBatch();
	assert.equal(res2.status, 409);
	const body2 = (await res2.json()) as { error: string; outstandingRequestId: string };
	assert.equal(body2.error, "OUTSTANDING_REQUEST");
	assert.equal(body2.outstandingRequestId, body.requestId);

	// The 409 dispatch created its own md proposals before enqueue conflicted;
	// those must be cleaned up so they don't linger as orphan 'requested' rows.
	// The two bound proposals from the first dispatch must survive.
	assert.equal(getProposal(body.items[0].previewId)?.state, "requested");
	assert.equal(getProposal(body.items[1].previewId)?.state, "requested");
	const Database = (await import("../../lib/sqlite.js")).default;
	const probe = new Database(path.join(process.env.HOME!, ".wiki-viewer", "live.db"));
	const { n } = probe.prepare("SELECT COUNT(*) AS n FROM md_proposal").get() as { n: number };
	probe.close();
	assert.equal(n, 2);
});

// NOTE ON BATCH ACCEPT SEMANTICS: both md proposals are created at the same
// dispatch-time baseRevision. md-resolve (intentionally unchanged) forwards that
// stored baseRevision to applyOps, which enforces a GLOBAL revision match.
// Accepting the first item bumps the doc revision, so a second accept on the
// same doc fails STALE_REVISION. This is the real, in-scope behavior: the batch
// preview lets the human accept one item verbatim; remaining items must be
// re-dispatched against the fresh revision. (md-resolve/applyOps are out of
// scope for this change, so this limitation is asserted rather than worked around.)
test("md-resolve accept commits chosen variant verbatim; second accept is STALE_REVISION", async () => {
	const { res } = await dispatchBatch();
	const body = (await res.json()) as {
		requestId: string;
		items: Array<{ instructionId: string; previewId: string }>;
	};
	const [a, b] = body.items;
	const submitted = await submitPreviews(body.requestId, [
		{
			previewId: a.previewId,
			variants: [
				{ variantId: "a1", label: "A1", markdown: "First rewritten." },
				{ variantId: "a2", label: "A2", markdown: "First alt." },
			],
		},
		{
			previewId: b.previewId,
			variants: [
				{ variantId: "b1", label: "B1", markdown: "Second rewritten." },
				{ variantId: "b2", label: "B2", markdown: "Second alt." },
			],
		},
	]);
	assert.equal(submitted.status, 200);
	const subBody = (await submitted.json()) as { items: Array<{ previewId: string; variants: number }> };
	assert.equal(subBody.items.length, 2);
	assert.equal(getProposal(a.previewId)?.state, "ready");
	assert.equal(getProposal(b.previewId)?.state, "ready");
	assert.equal(store.getRequest(body.requestId)?.state, "resolved");

	const acceptA = await mdResolvePOST(
		new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ previewId: a.previewId, action: "accept", variantId: "a1" }),
		}),
	);
	assert.equal(acceptA.status, 200);
	assert.equal(getProposal(a.previewId)?.state, "accepted");
	assert.equal(
		await readFile(path.join(rootA, filePath), "utf8"),
		"# Title\n\nFirst rewritten.\n\nSecond paragraph.\n",
	);

	// Second accept references the now-stale dispatch-time revision.
	const acceptB = await mdResolvePOST(
		new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ previewId: b.previewId, action: "accept", variantId: "b1" }),
		}),
	);
	assert.equal(acceptB.status, 409);
	assert.equal(((await acceptB.json()) as { error: string }).error, "STALE_REVISION");
});

test("kind discard frees the outstanding slot so a new dispatch succeeds", async () => {
	const { res } = await dispatchBatch();
	const body = (await res.json()) as { requestId: string };

	// Human cancel while waiting: resolve the outstanding request via kind discard.
	const discard = await requestPOST(
		new Request(userUrl("/api/wiki/live/request", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ path: filePath, kind: "discard", requestId: body.requestId }),
		}),
	);
	assert.equal(discard.status, 200);
	assert.equal(store.getRequest(body.requestId)?.state, "resolved");
	assert.equal(store.getRequest(body.requestId)?.outcome, "reverted");

	// Slot is free: a fresh dispatch succeeds instead of returning 409.
	const { res: res2 } = await dispatchBatch();
	assert.equal(res2.status, 200);
});

test("discarded preview cannot be accepted later", async () => {
	const { res } = await dispatchBatch();
	const body = (await res.json()) as {
		requestId: string;
		items: Array<{ instructionId: string; previewId: string }>;
	};
	const [a, b] = body.items;
	await submitPreviews(body.requestId, [
		{
			previewId: a.previewId,
			variants: [
				{ variantId: "a1", label: "A1", markdown: "First rewritten." },
				{ variantId: "a2", label: "A2", markdown: "First alt." },
			],
		},
		{
			previewId: b.previewId,
			variants: [
				{ variantId: "b1", label: "B1", markdown: "Second rewritten." },
				{ variantId: "b2", label: "B2", markdown: "Second alt." },
			],
		},
	]);

	for (const previewId of [a.previewId, b.previewId]) {
		const discarded = await mdResolvePOST(
			new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ previewId, action: "discard" }),
			}),
		);
		assert.equal(discarded.status, 200);
	}

	const accept = await mdResolvePOST(
		new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				previewId: a.previewId,
				action: "accept",
				variantId: "a1",
			}),
		}),
	);
	assert.equal(accept.status, 409);
	assert.equal(((await accept.json()) as { error: string }).error, "INVALID_STATE");
	assert.equal(await readFile(path.join(rootA, filePath), "utf8"), original);
});

test("md-resolve discard leaves file byte-identical", async () => {
	const { res } = await dispatchBatch();
	const body = (await res.json()) as {
		requestId: string;
		items: Array<{ instructionId: string; previewId: string }>;
	};
	const [a, b] = body.items;
	await submitPreviews(body.requestId, [
		{
			previewId: a.previewId,
			variants: [
				{ variantId: "a1", label: "A1", markdown: "First rewritten." },
				{ variantId: "a2", label: "A2", markdown: "First alt." },
			],
		},
		{
			previewId: b.previewId,
			variants: [
				{ variantId: "b1", label: "B1", markdown: "Second rewritten." },
				{ variantId: "b2", label: "B2", markdown: "Second alt." },
			],
		},
	]);
	const before = await readFile(path.join(rootA, filePath));
	for (const pid of [a.previewId, b.previewId]) {
		const discarded = await mdResolvePOST(
			new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ previewId: pid, action: "discard" }),
			}),
		);
		assert.equal(discarded.status, 200);
		assert.equal(getProposal(pid)?.state, "discarded");
	}
	assert.deepEqual(await readFile(path.join(rootA, filePath)), before);
});

test("base drift invalidates accept without writing file", async () => {
	const { res } = await dispatchBatch();
	const body = (await res.json()) as {
		requestId: string;
		items: Array<{ instructionId: string; previewId: string }>;
	};
	const [a, b] = body.items;
	await submitPreviews(body.requestId, [
		{
			previewId: a.previewId,
			variants: [
				{ variantId: "a1", label: "A1", markdown: "First rewritten." },
				{ variantId: "a2", label: "A2", markdown: "First alt." },
			],
		},
		{
			previewId: b.previewId,
			variants: [
				{ variantId: "b1", label: "B1", markdown: "Second rewritten." },
				{ variantId: "b2", label: "B2", markdown: "Second alt." },
			],
		},
	]);
	// Mutate the first targeted block on disk → its baseBlockHash drifts.
	await writeFile(
		path.join(rootA, filePath),
		"# Title\n\nChanged on disk.\n\nSecond paragraph.\n",
	);
	const before = await readFile(path.join(rootA, filePath));
	const drifted = await mdResolvePOST(
		new Request(userUrl("/api/wiki/live/md-resolve", wsA), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ previewId: a.previewId, action: "accept", variantId: "a1" }),
		}),
	);
	assert.equal(drifted.status, 409);
	assert.equal(((await drifted.json()) as { error: string }).error, "BASE_DRIFT");
	assert.deepEqual(await readFile(path.join(rootA, filePath)), before);
	assert.equal(getProposal(a.previewId)?.state, "invalidated");
});
