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

test("batch run: N instructions -> one preview run -> accept commits / discard invalidates", async () => {
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");

	// Send TWO pinned instructions as ONE run.
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/web-tweak/request", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({
				path: "index.html",
				items: [
					{
						instructionId: "p1",
						selector: "h1.title",
						tag: "h1",
						snippet: "<h1 class='title'>Hello</h1>",
						text: "Hello",
						instruction: "make the title red",
					},
					{
						instructionId: "p2",
						selector: "body",
						tag: "body",
						snippet: "<body>…</body>",
						text: "",
						instruction: "add a subtitle",
					},
				],
			}),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { previewId: string; runId: string; requestId: string };
	assert.ok(body.previewId && body.runId && body.requestId);
	assert.match(body.runId, /^run:/);

	// The run is stored as a single batch preview transaction carrying both items.
	const p = pstore.getPreview(body.previewId);
	assert.equal(p?.status, "requested");
	assert.equal(p?.runId, body.runId);
	assert.equal(p?.items?.length, 2);

	// Agent replies once for the whole run: per-instruction preview ops + a single
	// candidate patch (single-file v1 constraint).
	const newContent = original.replace(
		"<h1 class='title'>Hello</h1>",
		"<h1 class='title' style='color:red'>Hello</h1><p>subtitle</p>",
	);
	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId: body.previewId,
				requestId: body.requestId,
				itemPreviews: [
					{ instructionId: "p1", ops: [{ type: "setStyle", prop: "color", value: "red" }] },
					{ instructionId: "p2", ops: [{ type: "setText", value: "subtitle" }] },
				],
				candidateSourcePatch: {
					summary: "apply 2 instructions",
					files: [{ path: "index.html", content: newContent }],
				},
				baseFiles: [{ path: "index.html", sha256: sha256(original) }],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 200);

	// Source clean until accept.
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), original);

	// Status surfaces the batch (runId + items + per-instruction previews).
	const st = await statusGET(
		new Request(userUrl("/api/wiki/web-tweak/status", wsA, { previewId: body.previewId })),
	);
	const stBody = (await st.json()) as {
		acceptable: boolean;
		runId: string;
		items: unknown[];
		itemPreviews: unknown[];
	};
	assert.equal(stBody.acceptable, true);
	assert.equal(stBody.runId, body.runId);
	assert.equal(stBody.items.length, 2);
	assert.equal(stBody.itemPreviews.length, 2);

	// Accept commits the whole run in one write.
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId: body.previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 200);
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), newContent);
	assert.equal(pstore.getPreview(body.previewId)?.status, "accepted");
	// restore for other tests
	await writeFile(path.join(wsARoot, "index.html"), original, "utf8");
});

test("batch run: discard invalidates the run without writing source", async () => {
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/web-tweak/request", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({
				path: "index.html",
				items: [
					{
						instructionId: "p1",
						selector: "h1.title",
						tag: "h1",
						snippet: "<h1>Hello</h1>",
						text: "Hello",
						instruction: "make it blue",
					},
				],
			}),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { previewId: string; requestId: string };
	await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId: body.previewId,
				requestId: body.requestId,
				itemPreviews: [{ instructionId: "p1", ops: [{ type: "setStyle", prop: "color", value: "blue" }] }],
				candidateSourcePatch: { summary: "x", files: [{ path: "index.html", content: `${original}<!-- x -->` }] },
				baseFiles: [{ path: "index.html", sha256: sha256(original) }],
				status: "done",
			}),
		}),
	);
	const disc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId: body.previewId, action: "discard" }),
		}),
	);
	assert.equal(disc.status, 200);
	assert.equal(await readFile(path.join(wsARoot, "index.html"), "utf8"), original);
	assert.equal(pstore.getPreview(body.previewId)?.status, "discarded");
});

test("batch run: empty items[] is rejected", async () => {
	const res = await reqPOST(
		new Request(userUrl("/api/wiki/web-tweak/request", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ path: "index.html", items: [] }),
		}),
	);
	assert.equal(res.status, 400);
});

test("v1 rejects multi-file candidate patches", async () => {
	const { previewId, requestId } = await dispatchTweak(wsA);
	const cur = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const reply = await webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", wsA), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({
				previewId,
				requestId,
				domPreviewOps: [{ type: "setText", value: "x" }],
				candidateSourcePatch: {
					summary: "two files",
					files: [
						{ path: "index.html", content: cur },
						{ path: "other.html", content: "x" },
					],
				},
				baseFiles: [
					{ path: "index.html", sha256: sha256(cur) },
					{ path: "other.html", sha256: sha256("") },
				],
				status: "done",
			}),
		}),
	);
	assert.equal(reply.status, 400);
});

// ─── Variants (step 2): one target, N candidate options, accept exactly one ────

async function dispatchVariants(
	ws: string,
	note = "give me color options",
): Promise<{ previewId: string; requestId: string }> {
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
				variants: true,
			}),
		}),
	);
	assert.equal(res.status, 200);
	const body = (await res.json()) as { previewId: string; requestId: string; variants?: boolean };
	assert.ok(body.previewId && body.requestId);
	assert.equal(body.variants, true);
	return body;
}

function variantReply(ws: string, previewId: string, requestId: string, variants: unknown[]) {
	return webPreviewPOST(
		new Request(agentUrl("/api/agent/live/web-preview", ws), {
			method: "POST",
			headers: agentHeaders(),
			body: JSON.stringify({ previewId, requestId, status: "done", variants }),
		}),
	);
}

test("variants: agent returns N candidates; accept commits the SELECTED one verbatim", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const redContent = original.replace("Hello</h1>", "Hello RED</h1>");
	const blueContent = original.replace("Hello</h1>", "Hello BLUE</h1>");
	const base = [{ path: "index.html", sha256: sha256(original) }];

	const reply = await variantReply(wsA, previewId, requestId, [
		{
			variantId: "v-red",
			label: "Red",
			domPreviewOps: [{ type: "setStyle", prop: "color", value: "red" }],
			candidateSourcePatch: { summary: "red", files: [{ path: "index.html", content: redContent }] },
			baseFiles: base,
		},
		{
			variantId: "v-blue",
			label: "Blue",
			domPreviewOps: [{ type: "setStyle", prop: "color", value: "blue" }],
			candidateSourcePatch: { summary: "blue", files: [{ path: "index.html", content: blueContent }] },
			baseFiles: base,
		},
	]);
	assert.equal(reply.status, 200);
	const p = pstore.getPreview(previewId);
	assert.equal(p?.status, "preview-ready");
	assert.equal(p?.variants?.length, 2);

	// Accept the blue variant explicitly.
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept", variantId: "v-blue" }),
		}),
	);
	assert.equal(acc.status, 200);
	const written = await readFile(path.join(wsARoot, "index.html"), "utf8");
	assert.equal(written, blueContent);
	assert.ok(!written.includes("Hello RED"));
});

test("variants: accept without variantId is rejected", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	await variantReply(wsA, previewId, requestId, [
		{
			variantId: "v1",
			label: "One",
			domPreviewOps: [{ type: "setText", value: "x" }],
			candidateSourcePatch: { summary: "one", files: [{ path: "index.html", content: `${original}<!--1-->` }] },
			baseFiles: [{ path: "index.html", sha256: sha256(original) }],
		},
		{ variantId: "v2", label: "Two", domPreviewOps: null, candidateSourcePatch: null, baseFiles: [] },
	]);
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept" }),
		}),
	);
	assert.equal(acc.status, 400);
	// Preview still resolvable after a rejected accept (claim released).
	assert.equal(pstore.getPreview(previewId)?.status, "preview-ready");
});

test("variants: unknown variantId is rejected", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	await variantReply(wsA, previewId, requestId, [
		{
			variantId: "real",
			label: "Real",
			domPreviewOps: null,
			candidateSourcePatch: { summary: "r", files: [{ path: "index.html", content: `${original}<!--r-->` }] },
			baseFiles: [{ path: "index.html", sha256: sha256(original) }],
		},
		{ variantId: "real2", label: "Real 2", domPreviewOps: null, candidateSourcePatch: null, baseFiles: [] },
	]);
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept", variantId: "ghost" }),
		}),
	);
	assert.equal(acc.status, 400);
});

test("variants: single-candidate reply is rejected (needs >= 2)", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const reply = await variantReply(wsA, previewId, requestId, [
		{ variantId: "only", label: "Only", domPreviewOps: [{ type: "setText", value: "x" }], candidateSourcePatch: null, baseFiles: [] },
	]);
	assert.equal(reply.status, 400);
	assert.equal(pstore.getPreview(previewId)?.status, "requested");
});

test("variants: over-cap reply is rejected", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const many = Array.from({ length: pstore.MAX_VARIANTS + 1 }, (_, i) => ({
		variantId: `v${i}`,
		label: `V${i}`,
		domPreviewOps: [{ type: "setText", value: String(i) }],
		candidateSourcePatch: null,
		baseFiles: [],
	}));
	const reply = await variantReply(wsA, previewId, requestId, many);
	assert.equal(reply.status, 400);
	assert.equal(pstore.getPreview(previewId)?.status, "requested");
	// keep original referenced
	assert.ok(original.length > 0);
});

test("variants: multi-file candidate in a variant is rejected", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	const reply = await variantReply(wsA, previewId, requestId, [
		{
			variantId: "multi",
			label: "Multi",
			domPreviewOps: null,
			candidateSourcePatch: {
				summary: "two files",
				files: [
					{ path: "index.html", content: original },
					{ path: "other.html", content: "x" },
				],
			},
			baseFiles: [
				{ path: "index.html", sha256: sha256(original) },
				{ path: "other.html", sha256: sha256("") },
			],
		},
	]);
	assert.equal(reply.status, 400);
});

test("variants: base drift invalidates accept, nothing written", async () => {
	const { previewId, requestId } = await dispatchVariants(wsA);
	const original = await readFile(path.join(wsARoot, "index.html"), "utf8");
	await variantReply(wsA, previewId, requestId, [
		{
			variantId: "d1",
			label: "Drift",
			domPreviewOps: null,
			candidateSourcePatch: { summary: "d", files: [{ path: "index.html", content: `${original}<!--d-->` }] },
			baseFiles: [{ path: "index.html", sha256: sha256(original) }],
		},
		{ variantId: "d2", label: "Drift 2", domPreviewOps: null, candidateSourcePatch: null, baseFiles: [] },
	]);
	// Human edits the file out-of-band after preview.
	await writeFile(path.join(wsARoot, "index.html"), `${original}<!--human-->`, "utf8");
	const acc = await resolvePOST(
		new Request(userUrl("/api/wiki/web-tweak/resolve", wsA), {
			method: "POST",
			headers: userHeaders(),
			body: JSON.stringify({ previewId, action: "accept", variantId: "d1" }),
		}),
	);
	assert.equal(acc.status, 409);
	const after = await readFile(path.join(wsARoot, "index.html"), "utf8");
	assert.equal(after, `${original}<!--human-->`);
	assert.equal(pstore.getPreview(previewId)?.status, "invalidated");
});
