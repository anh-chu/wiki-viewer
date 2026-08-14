/**
 * Web-tweak live collaboration — preview transaction lifecycle.
 *
 * Covers the impeccable-grade contract: web.tweak creates a preview transaction;
 * the agent attaches DOM preview ops + an immutable candidate source patch +
 * base hashes; accept commits the candidate VERBATIM iff base hashes still match;
 * base drift invalidates; a null candidate is visual-only (no accept); workspace
 * isolation; no source write before accept.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes, createHash } from "node:crypto";

import { createTestWorkspace, makeFile } from "./helpers/workspace.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";

let tmpHome: string;
let wsA: string;
let wsARoot: string;
let wsB: string;
let TOKEN: string;

let reqPOST: (req: Request) => Promise<Response>;
let webPreviewPOST: (req: Request) => Promise<Response>;
let resolvePOST: (req: Request) => Promise<Response>;
let statusGET: (req: Request) => Promise<Response>;
let attachPOST: (req: Request) => Promise<Response>;
let store: typeof import("../../lib/proof/live/store.js");
let pstore: typeof import("../../lib/web-tweak/preview-store.js");

function sha256(s: string): string {
	return createHash("sha256").update(s).digest("hex");
}

function agentHeaders(): Record<string, string> {
	return {
		Authorization: `Bearer ${TOKEN}`,
		"X-Agent-Id": "ai:web-agent",
		"Content-Type": "application/json",
	};
}
function userHeaders(): Record<string, string> {
	return { "Content-Type": "application/json" };
}
function agentUrl(route: string, ws: string): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", ws);
	return url.toString();
}
function userUrl(route: string, ws: string, params: Record<string, string> = {}): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", ws);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	return url.toString();
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "webtweak-home-"));
	process.env.HOME = tmpHome;
	process.env.WIKI_NO_AUTH = "1";

	const a = await createTestWorkspace({ name: "wt-a" });
	const b = await createTestWorkspace({ name: "wt-b" });
	wsA = a.workspace.id;
	wsARoot = a.rootDir;
	wsB = b.workspace.id;
	await makeFile(a.rootDir, "index.html", "<html><body><h1 class='title'>Hello</h1></body></html>\n");

	await ensureRegistry();
	TOKEN = randomBytes(32).toString("hex");
	await addAgent({
		id: "ai:web-agent",
		displayName: "Web Agent",
		tokenHash: hashToken(TOKEN),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	store = await import("../../lib/proof/live/store.js");
	pstore = await import("../../lib/web-tweak/preview-store.js");
	store._resetForTests();
	pstore._resetForTests();

	reqPOST = (await import("../../app/api/wiki/web-tweak/request/route.js")).POST;
	webPreviewPOST = (await import("../../app/api/agent/live/web-preview/route.js")).POST;
	resolvePOST = (await import("../../app/api/wiki/web-tweak/resolve/route.js")).POST;
	statusGET = (await import("../../app/api/wiki/web-tweak/status/route.js")).GET;
	attachPOST = (await import("../../app/api/agent/live/attach/route.js")).POST;
});

after(async () => {
	store?._resetForTests();
	pstore?._resetForTests();
	await rm(tmpHome, { recursive: true, force: true });
	delete process.env.WIKI_NO_AUTH;
});

async function dispatchTweak(ws: string, note = "make the title red"): Promise<{ previewId: string; requestId: string }> {
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/web-tweak/request", ws), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({
				path: "index.html",
				selector: "h1.title",
				tag: "h1",
				snippet: "<h1 class='title'>Hello</h1>",
				text: "Hello",
				note,
			}),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { previewId: string; requestId: string };
	assert.ok(body.previewId && body.requestId);
	return body;
}

test("web.tweak creates a preview transaction and enqueues a live request", async () => {
	const { previewId } = await dispatchTweak(wsA);
	const p = pstore.getPreview(previewId);
	assert.ok(p);
	assert.equal(p?.status, "requested");
	assert.equal(p?.selector, "h1.title");
});

test("agent attaches DOM ops + candidate patch; accept commits verbatim iff base matches", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const newContent = original.replace("<h1 class='title'>Hello</h1>", "<h1 class='title' style='color:red'>Hello</h1>");

	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setStyle", prop: "color", value: "red" }],
				candidateSourcePatch: {
					summary: "add inline red color to the title",
					files: [{ path: "index.html", content: newContent }],
				},
				baseFiles: [{ path: "index.html", sha256: sha256(original) }],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 200);

	// Preview is ready, but the source file is UNCHANGED (no write before accept).
	const p = pstore.getPreview(previewId);
	assert.equal(p?.status, "preview-ready");
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), original);

	// Status endpoint surfaces the DOM ops + acceptability.
	const st = await statusGET(new Request(userUrl("/api/wiki/web-tweak/status", wsA, { previewId })));
	const stBody = (await st.json()) as { acceptable: boolean; domPreviewOps: unknown[] };
	assert.equal(stBody.acceptable, true);
	assert.equal(stBody.domPreviewOps.length, 1);

	// Accept: base hash matches, candidate written verbatim.
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 200);
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), newContent);
	assert.equal(pstore.getPreview(previewId)?.status, "accepted");
});

test("accept fails closed on base drift (source changed since preview)", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	const atRead = await readFile(path.join(wsARoot, "index.html"), "utf8");

	await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setText", value: "Changed" }],
				candidateSourcePatch: { summary: "x", files: [{ path: "index.html", content: `${atRead}<!-- x -->` }] },
				baseFiles: [{ path: "index.html", sha256: sha256(atRead) }],
				status: "done",
			}),
		}),
	);

	// A concurrent edit changes the file after the preview was produced.
	await writeFile(path.join(wsARoot, "index.html"), `${atRead}<!-- concurrent -->`, "utf8");

	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 409);
	const body = (await acc.json()) as { error: string };
	assert.equal(body.error, "BASE_DRIFT");
	assert.equal(pstore.getPreview(previewId)?.status, "invalidated");
	// restore for other tests
	await writeFile(path.join(wsARoot, "index.html"), atRead, "utf8");
});

test("null candidate is visual-only: accept is refused", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setStyle", prop: "opacity", value: "0.5" }],
				candidateSourcePatch: null,
				baseFiles: [],
				status: "done",
			}),
		}),
	);
	const st = await statusGET(new Request(userUrl("/api/wiki/web-tweak/status", wsA, { previewId })));
	assert.equal(((await st.json()) as { acceptable: boolean }).acceptable, false);

	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 422);
	assert.equal(((await acc.json()) as { error: string }).error, "NO_CANDIDATE");
});

test("discard resolves without writing source", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	const before = await readFile(path.join(wsARoot, "index.html"), "utf8");
	await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setText", value: "nope" }],
				candidateSourcePatch: { summary: "x", files: [{ path: "index.html", content: "ZZZ" }] },
				baseFiles: [{ path: "index.html", sha256: sha256(before) }],
				status: "done",
			}),
		}),
	);
	const disc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "discard" }),
		}),
	);
	assert.equal(disc.status, 200);
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), before);
	assert.equal(pstore.getPreview(previewId)?.status, "discarded");
});

test("workspace isolation: cannot resolve another workspace's preview", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setText", value: "x" }],
				candidateSourcePatch: { summary: "x", files: [{ path: "index.html", content: "x" }] },
				baseFiles: [{ path: "index.html", sha256: "deadbeef" }],
				status: "done",
			}),
		}),
	);
	// Resolve via wsB must not find the wsA preview.
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsB), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 404);
});

test("agent reply for a foreign-workspace preview is rejected", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	// Agent submits against wsB while the preview belongs to wsA.
	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsB), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: null,
				candidateSourcePatch: null,
				baseFiles: [],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 404);
});

test("agent reply requires requestId matching the preview's dispatched request", async () => {
	const { previewId } = await dispatchTweak(wsA);
	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId: "lr_wrong",
				domPreviewOps: null,
				candidateSourcePatch: null,
				baseFiles: [],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 400);
	assert.equal(((await reply.json()) as { error: string }).error, "REQUEST_MISMATCH");
});

test("candidate target without a base hash is rejected at reply time", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setText", value: "x" }],
				// candidate writes index.html but base only covers other.txt
				candidateSourcePatch: { summary: "x", files: [{ path: "index.html", content: "ZZZ" }] },
				baseFiles: [{ path: "other.txt", sha256: sha256("") }],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 400);
	assert.equal(((await reply.json()) as { error: string }).error, "INVALID_PARAM");
	// preview stays requested (not attached)
	assert.equal(pstore.getPreview(previewId)?.status, "requested");
});
