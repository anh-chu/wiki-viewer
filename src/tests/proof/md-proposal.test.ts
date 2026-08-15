import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestWorkspace, makeFile } from "./helpers/workspace.js";
import { readSnapshot } from "../../lib/proof/ops-applier.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import {
	_resetForTests,
	attachVariants,
	claimForResolve,
	createProposal,
	getProposal,
	markResolved,
} from "../../lib/proof/live/md-proposal-store.js";

let wsA: string;
let rootA: string;
let wsB: string;
let resolvePOST: (req: Request) => Promise<Response>;
let statusGET: (req: Request) => Promise<Response>;
let mdRequestPOST: (req: Request) => Promise<Response>;
let attachPOST: (req: Request) => Promise<Response>;
let pollGET: (req: Request) => Promise<Response>;
let mdPreviewPOST: (req: Request) => Promise<Response>;
let mutateToken: string;

const filePath = "proposal.md";
const original = "# Title\n\nOriginal paragraph.\n";

function url(route: string, ws: string, params: Record<string, string> = {}): string {
	const u = new URL(`http://localhost:3000${route}`);
	u.searchParams.set("ws", ws);
	for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
	return u.toString();
}

function agentHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${mutateToken}`, "X-Agent-Id": "ai:md-proposal-agent", "Content-Type": "application/json" };
}

function agentUrl(route: string, ws: string, params: Record<string, string> = {}): string {
	const u = new URL(`http://localhost:3000${route}`);
	u.searchParams.set("ws", ws);
	for (const [key, value] of Object.entries(params)) u.searchParams.set(key, value);
	return u.toString();
}

function canonicalHash(markdown: string): string {
	const hex = createHash("sha256").update(new TextEncoder().encode(markdown)).digest("hex");
	return `sha256:${hex}`;
}

async function target() {
	const snapshot = await readSnapshot(rootA, filePath);
	assert.ok(snapshot);
	const block = snapshot.blocks.find((item) => item.type === "paragraph");
	assert.ok(block);
	return { snapshot, block };
}

function proposal(baseBlockHash: string) {
	return createProposal({
		workspaceId: wsA,
		path: filePath,
		blockRef: "b",
		baseRevision: 0,
		baseBlockHash,
	});
}

async function makeProposal() {
	const { snapshot, block } = await target();
	const p = createProposal({
		workspaceId: wsA,
		path: filePath,
		blockRef: block.ref,
		baseRevision: snapshot.revision,
		baseBlockHash: canonicalHash(block.markdown),
	});
	return { p, block };
}

async function attach(previewId: string, variants = [
	{ variantId: "v-one", label: "One", markdown: "Chosen **one**." },
	{ variantId: "v-two", label: "Two", markdown: "Chosen _two_." },
]) {
	const result = attachVariants(previewId, variants);
	assert.ok(result);
	return result;
}

before(async () => {
	process.env.HOME = await mkdtemp(path.join(tmpdir(), "md-proposal-home-"));
	process.env.WIKI_NO_AUTH = "1";
	const a = await createTestWorkspace({ name: "md-proposal-a" });
	const b = await createTestWorkspace({ name: "md-proposal-b" });
	wsA = a.workspace.id;
	rootA = a.rootDir;
	wsB = b.workspace.id;
	await makeFile(rootA, filePath, original);
	await ensureRegistry();
	mutateToken = randomBytes(32).toString("hex");
	await addAgent({ id: "ai:md-proposal-agent", displayName: "MD Proposal Agent", tokenHash: hashToken(mutateToken), scope: { paths: ["**/*"], ops: ["read", "mutate"] }, createdAt: new Date().toISOString(), lastSeen: new Date().toISOString() });
	resolvePOST = (await import("../../app/api/wiki/live/md-resolve/route.js")).POST;
	statusGET = (await import("../../app/api/wiki/live/md-status/route.js")).GET;
	mdRequestPOST = (await import("../../app/api/wiki/live/md-request/route.js")).POST;
	attachPOST = (await import("../../app/api/agent/live/attach/route.js")).POST;
	pollGET = (await import("../../app/api/agent/live/poll/route.js")).GET;
	mdPreviewPOST = (await import("../../app/api/agent/live/md-preview/route.js")).POST;
	_resetForTests();
});

after(async () => {
	_resetForTests();
	await rm(process.env.HOME!, { recursive: true, force: true });
	delete process.env.WIKI_NO_AUTH;
});

beforeEach(async () => {
	await writeFile(path.join(rootA, filePath), original);
});

test("lifecycle: requested proposal attaches 2-5 variants and derives IDs", async () => {
	const { snapshot, block } = await target();
	const p = createProposal({ workspaceId: wsA, path: filePath, blockRef: block.ref, baseRevision: snapshot.revision, baseBlockHash: canonicalHash(block.markdown) });
	assert.equal(p.state, "requested");
	const ready = attachVariants(p.previewId, [
		{ label: "One", markdown: "First." },
		{ label: "Two", markdown: "Second." },
	]);
	assert.ok(ready);
	assert.equal(ready.state, "ready");
	assert.equal(ready.variants.length, 2);
	assert.ok(ready.variants.every((v) => v.variantId));
	const status = await statusGET(new Request(url("/api/wiki/live/md-status", wsA, { previewId: p.previewId })));
	assert.equal(status.status, 200);
	assert.equal(((await status.json()) as { state: string }).state, "ready");
});

test("md-request computes canonical hash and md-preview proposal accepts unchanged block", async () => {
	const { snapshot, block } = await target();
	const attached = await attachPOST(new Request(agentUrl("/api/agent/live/attach", wsA), { method: "POST", headers: agentHeaders() }));
	assert.equal(attached.status, 200);
	const { sessionId } = (await attached.json()) as { sessionId: string };
	const requested = await mdRequestPOST(new Request(url("/api/wiki/live/md-request", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ path: filePath, blockRef: block.ref, baseRevision: snapshot.revision, instruction: "Rewrite paragraph" }),
	}));
	assert.equal(requested.status, 200);
	const requestedBody = (await requested.json()) as { previewId: string; requestId: string };
	const polled = await pollGET(new Request(agentUrl("/api/agent/live/poll", wsA, { sessionId, afterSeq: "0", holdMs: "1000" }), { headers: agentHeaders() }));
	assert.equal(polled.status, 200);
	const pollBody = (await polled.json()) as { type: string; request: { requestId: string; previewId: string | null } };
	assert.equal(pollBody.type, "generate");
	assert.equal(pollBody.request.requestId, requestedBody.requestId);
	assert.equal(pollBody.request.previewId, requestedBody.previewId);
	const submitted = await mdPreviewPOST(new Request(agentUrl("/api/agent/live/md-preview", wsA), {
		method: "POST", headers: agentHeaders(),
		body: JSON.stringify({ previewId: requestedBody.previewId, requestId: requestedBody.requestId, variants: [{ label: "One", markdown: "First." }, { label: "Two", markdown: "Second." }] }),
	}));
	assert.equal(submitted.status, 200);
	const stored = getProposal(requestedBody.previewId);
	assert.equal(stored?.baseBlockHash, canonicalHash(block.markdown));
	assert.equal(stored?.state, "ready");
	const accepted = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: requestedBody.previewId, action: "accept", variantId: stored!.variants[0].variantId }),
	}));
	assert.equal(accepted.status, 200);
	assert.equal(await readFile(path.join(rootA, filePath), "utf8"), "# Title\n\nFirst.\n");
});

test("accept commits selected variant markdown verbatim and marks accepted", async () => {
	const { p } = await makeProposal();
	await attach(p.previewId);
	const ready = getProposal(p.previewId)!;
	const chosen = ready.variants[0];
	const response = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: p.previewId, action: "accept", variantId: chosen.variantId }),
	}));
	assert.equal(response.status, 200);
	const after = await readSnapshot(rootA, filePath);
	assert.equal(after?.blocks.find((b) => b.type === "paragraph")?.markdown, chosen.markdown);
	assert.equal(await readFile(path.join(rootA, filePath), "utf8"), `# Title\n\n${chosen.markdown}\n`);
	assert.equal(getProposal(p.previewId)?.state, "accepted");
});

test("discard leaves file byte-identical and marks discarded", async () => {
	const { p } = await makeProposal();
	await attach(p.previewId);
	const before = await readFile(path.join(rootA, filePath));
	const response = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: p.previewId, action: "discard" }),
	}));
	assert.equal(response.status, 200);
	assert.deepEqual(await readFile(path.join(rootA, filePath)), before);
	assert.equal(getProposal(p.previewId)?.state, "discarded");
});

test("base drift invalidates accept without writing file", async () => {
	const { p } = await makeProposal();
	await attach(p.previewId);
	await writeFile(path.join(rootA, filePath), "# Title\n\nChanged on disk.\n");
	const before = await readFile(path.join(rootA, filePath));
	const response = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: p.previewId, action: "accept", variantId: "v-one" }),
	}));
	assert.equal(response.status, 409);
	assert.equal(((await response.json()) as { error: string }).error, "BASE_DRIFT");
	assert.deepEqual(await readFile(path.join(rootA, filePath)), before);
	assert.equal(getProposal(p.previewId)?.state, "invalidated");
});

test("attachVariants enforces 2-5 variants", async () => {
	for (const variants of [[], [{ label: "one", markdown: "x" }], Array.from({ length: 6 }, (_, i) => ({ label: String(i), markdown: String(i) }))]) {
		const p = createProposal({ workspaceId: wsA, path: filePath, blockRef: "b", baseRevision: 0, baseBlockHash: "hash" });
		assert.equal(attachVariants(p.previewId, variants), null);
		assert.equal(getProposal(p.previewId)?.state, "requested");
	}
});

test("proposal cannot be resolved through another workspace", async () => {
	const { p } = await makeProposal();
	await attach(p.previewId);
	const response = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsB), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: p.previewId, action: "accept", variantId: "v-one" }),
	}));
	assert.equal(response.status, 404);
	assert.equal(((await response.json()) as { error: string }).error, "PREVIEW_NOT_FOUND");
	assert.equal(getProposal(p.previewId)?.state, "ready");
});

test("accept accepts client canonical sha256 hash", async () => {
	const { snapshot, block } = await target();
	const p = createProposal({ workspaceId: wsA, path: filePath, blockRef: block.ref, baseRevision: snapshot.revision, baseBlockHash: canonicalHash(block.markdown) });
	await attach(p.previewId, [{ variantId: "canonical", label: "Canonical", markdown: "Canonical result." }, { variantId: "other", label: "Other", markdown: "Other result." }]);
	const response = await resolvePOST(new Request(url("/api/wiki/live/md-resolve", wsA), {
		method: "POST", headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ previewId: p.previewId, action: "accept", variantId: "canonical" }),
	}));
	assert.equal(response.status, 200);
	assert.equal(getProposal(p.previewId)?.state, "accepted");
});

test("store resolve lifecycle supports claim, release, and markResolved", () => {
	const p = proposal("unused");
	assert.equal(claimForResolve(p.previewId), null);
	const ready = attachVariants(p.previewId, [{ label: "one", markdown: "1" }, { label: "two", markdown: "2" }]);
	assert.ok(ready);
	assert.equal(claimForResolve(p.previewId)?.state, "resolving");
	assert.equal(markResolved(p.previewId, "accepted", ready.variants[0].variantId)?.state, "accepted");
});
