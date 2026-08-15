import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createTestWorkspace, makeFile } from "./helpers/workspace.js";
import { readSnapshot } from "../../lib/proof/ops-applier.js";
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

const filePath = "proposal.md";
const original = "# Title\n\nOriginal paragraph.\n";

function url(route: string, ws: string, params: Record<string, string> = {}): string {
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
	resolvePOST = (await import("../../app/api/wiki/live/md-resolve/route.js")).POST;
	statusGET = (await import("../../app/api/wiki/live/md-status/route.js")).GET;
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
