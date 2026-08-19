import { test, describe, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

import { createTestWorkspace, makeFile, type CreatedWorkspace } from "./helpers/workspace.js";
import { ensureRegistry, addAgent, hashToken } from "../../lib/proof/registry.js";
import { __setSpawnerForTest, getEngine, stopEngine } from "../../lib/live-engine/supervisor.js";

class StubChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = Math.floor(Math.random() * 100_000) + 1;
	killed = false;

	constructor(readonly server: Server) {
		super();
	}

	kill(): boolean {
		if (this.killed) return true;
		this.killed = true;
		this.server.close();
		this.emit("exit", 0, null);
		return true;
	}
}

type StubEvent = Record<string, unknown>;
type StubReply = Record<string, unknown>;
type StubState = { token: string; events: StubEvent[]; replies: StubReply[]; server: Server };

const stubs = new Map<number, StubState>();
const children = new Set<StubChild>();
let spawnGeneration = 0;

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(body));
}

function stubSpawner(_file: string, args: string[]): StubChild {
	const portArg = args.find((arg) => arg.startsWith("--port="));
	const port = Number(portArg?.slice("--port=".length));
	const token = `ops12-token-${++spawnGeneration}`;
	const state: StubState = { token, events: [], replies: [], server: createServer() };
	state.server.on("request", (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.pathname !== "/health" && url.searchParams.get("token") !== token) {
			json(response, 401, { error: "UNAUTHORIZED" });
			return;
		}
		if (url.pathname === "/health") {
			json(response, 200, { status: "ok", port });
			return;
		}
		if (url.pathname === "/poll" && request.method === "GET") {
			const event = state.events.shift();
			setTimeout(() => json(response, 200, event ?? { type: "timeout" }), 2);
			return;
		}
		if (url.pathname === "/poll" && request.method === "POST") {
			let body = "";
			request.setEncoding("utf8");
			request.on("data", (chunk) => { body += chunk; });
			request.on("end", () => {
				try { state.replies.push(JSON.parse(body) as StubReply); } catch { /* malformed test request */ }
				json(response, 200, { ok: true });
			});
			return;
		}
		if (url.pathname === "/status") {
			json(response, 200, { status: "ok" });
			return;
		}
		if (url.pathname === "/stop") {
			response.writeHead(200);
			response.end("stopping");
			return;
		}
		json(response, 404, { error: "NOT_FOUND" });
	});
	const child = new StubChild(state.server);
	children.add(child);
	stubs.set(port, state);
	state.server.listen(port, "127.0.0.1", () => {
		child.stdout.write(`${JSON.stringify({ pid: child.pid, port, token })}\n`);
	});
	return child;
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

const ORIGINAL = "<!doctype html>\n<html><body><h1 class=\"title\">Original</h1></body></html>\n";
const SCAFFOLD = `<!-- impeccable-carbonize-start panel -->
<style data-impeccable-css="panel">
.title { color: var(--p-color, red); }
</style>
<!-- impeccable-carbonize-end panel -->
<div data-impeccable-variant="red"><h1 class="title" data-p-color="red">Red</h1></div>
<div data-impeccable-variant="blue"><h1 class="title" data-p-color="blue">Blue</h1></div>
`;

let tmpHome: string;
let workspaceA: CreatedWorkspace;
let workspaceB: CreatedWorkspace;
let token: string;
let liveStore: typeof import("../../lib/proof/live/store.js");
let scaffoldStore: typeof import("../../lib/proof/live/scaffold-store.js");
let previewStore: typeof import("../../lib/web-tweak/preview-store.js");
let bridge: typeof import("../../lib/proof/live/web-bridge.js");
let sessionPOST: (request: Request) => Promise<Response>;
let resolvePOST: (request: Request) => Promise<Response>;
let statusGET: (request: Request) => Promise<Response>;
let webPreviewPOST: (request: Request) => Promise<Response>;
type PreviewTransaction = import("../../lib/web-tweak/preview-store.js").PreviewTransaction;

function userUrl(ws: string, route: string, params: Record<string, string> = {}): string {
	const url = new URL(`http://localhost:3000${route}`);
	url.searchParams.set("ws", ws);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	return url.toString();
}

function userHeaders(): Record<string, string> {
	return { Origin: "http://localhost:3000", "Content-Type": "application/json" };
}

function agentHeaders(ws: string): Record<string, string> {
	return {
		Authorization: `Bearer ${token}`,
		"X-Agent-Id": "ai:ops12",
		"X-Workspace": ws,
		"Content-Type": "application/json",
	};
}

function engineState(port: number): StubState {
	const state = stubs.get(port);
	assert.ok(state, `missing stub engine on port ${port}`);
	return state;
}

function queueEvent(port: number, event: StubEvent): void {
	engineState(port).events.push(event);
}

async function waitFor<T, S extends T>(
	read: () => T | Promise<T>,
	predicate: (value: T) => value is S,
	label: string,
): Promise<S>;
async function waitFor<T>(
	read: () => T | Promise<T>,
	predicate: (value: T) => boolean,
	label: string,
): Promise<T>;
async function waitFor<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, label: string): Promise<T> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const value = await read();
		if (predicate(value)) return value;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function startSession(ws = workspaceA.workspace.id): Promise<{ port: number; scaffoldId: string }> {
	const response = await sessionPOST(new Request(userUrl(ws, "/api/wiki/live-web/session"), {
		method: "POST",
		headers: userHeaders(),
		body: JSON.stringify({ path: "index.html" }),
	}));
	assert.equal(response.status, 200);
	const body = (await response.json()) as { port: number; scaffoldId: string };
	assert.equal(typeof body.port, "number");
	assert.match(body.scaffoldId, /^lws_/);
	return body;
}

function latestRequest(ws = workspaceA.workspace.id) {
	const session = liveStore.latestOpenSession(ws);
	assert.ok(session);
	return liveStore.latestRequest(session.id);
}

async function waitForPreview(ws = workspaceA.workspace.id): Promise<PreviewTransaction> {
	return waitFor(
		() => {
			const request = latestRequest(ws);
			return request?.previewId ? previewStore.getPreview(request.previewId) : null;
		},
		(preview): preview is PreviewTransaction => preview !== null,
		"preview request",
	);
}

async function attachScaffold(ws: string, scaffold = SCAFFOLD): Promise<{ requestId: string; previewId: string; scaffoldId: string }> {
	const preview = await waitForPreview(ws);
	assert.ok(preview.requestId);
	const response = await webPreviewPOST(new Request(userUrl(ws, "/api/agent/live/web-preview"), {
		method: "POST",
		headers: agentHeaders(ws),
		body: JSON.stringify({
			previewId: preview.id,
			requestId: preview.requestId,
			status: "done",
			variants: [
				{ variantId: "red", label: "Red", scaffold, domPreviewOps: [], candidateSourcePatch: null, baseFiles: [] },
				{ variantId: "blue", label: "Blue", domPreviewOps: [], candidateSourcePatch: null, baseFiles: [] },
			],
		}),
	}));
	assert.equal(response.status, 200);
	const activeScaffold = scaffoldStore.getLatestScaffold(ws, "index.html");
	assert.ok(activeScaffold);
	return { requestId: preview.requestId, previewId: preview.id, scaffoldId: activeScaffold.id };
}

async function resolve(ws: string, body: Record<string, unknown>): Promise<Response> {
	return resolvePOST(new Request(userUrl(ws, "/api/wiki/live-web/resolve"), {
		method: "POST",
		headers: userHeaders(),
		body: JSON.stringify({ path: "index.html", ...body }),
	}));
}

before(async () => {
	tmpHome = await mkdtemp(path.join(tmpdir(), "ops12-live-web-home-"));
	process.env.HOME = tmpHome;
	process.env.WIKI_NO_AUTH = "1";
	workspaceA = await createTestWorkspace({ name: "ops12-a" });
	workspaceB = await createTestWorkspace({ name: "ops12-b" });
	await makeFile(workspaceA.rootDir, "index.html", ORIGINAL);
	await makeFile(workspaceB.rootDir, "index.html", ORIGINAL);

	await ensureRegistry();
	token = randomBytes(32).toString("hex");
	await addAgent({
		id: "ai:ops12",
		displayName: "OPS-12 test agent",
		tokenHash: hashToken(token),
		scope: { paths: ["**/*"], ops: ["read", "mutate"] },
		createdAt: new Date().toISOString(),
		lastSeen: new Date().toISOString(),
	});

	liveStore = await import("../../lib/proof/live/store.js");
	scaffoldStore = await import("../../lib/proof/live/scaffold-store.js");
	previewStore = await import("../../lib/web-tweak/preview-store.js");
	bridge = await import("../../lib/proof/live/web-bridge.js");
	({ POST: sessionPOST } = await import("../../app/api/wiki/live-web/session/route.js"));
	({ POST: resolvePOST } = await import("../../app/api/wiki/live-web/resolve/route.js"));
	({ GET: statusGET } = await import("../../app/api/wiki/live-web/status/route.js"));
	({ POST: webPreviewPOST } = await import("../../app/api/agent/live/web-preview/route.js"));
	__setSpawnerForTest(stubSpawner as never);
});

async function resetLiveState(): Promise<void> {
	bridge._resetForTests();
	// The bridge loop is deliberately fire-and-forget; let an in-flight poll or
	// reply observe abort before closing its stores for the next test.
	await new Promise((resolve) => setTimeout(resolve, 25));
	liveStore._resetForTests();
	previewStore._resetForTests();
	scaffoldStore._resetForTests();
	await rm(path.join(tmpHome, ".wiki-viewer", "live.db"), { force: true });
}

beforeEach(async () => {
	await resetLiveState();
	await writeFile(path.join(workspaceA.rootDir, "index.html"), ORIGINAL);
	await writeFile(path.join(workspaceB.rootDir, "index.html"), ORIGINAL);
});

afterEach(async () => {
	await stopEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" });
	await stopEngine({ workspaceId: workspaceB.workspace.id, relPath: "index.html" });
	for (const child of children) child.kill();
	children.clear();
	stubs.clear();
	await resetLiveState();
});

after(async () => {
	__setSpawnerForTest(null);
	await rm(workspaceA.rootDir, { recursive: true, force: true });
	await rm(workspaceB.rootDir, { recursive: true, force: true });
	await rm(tmpHome, { recursive: true, force: true });
	delete process.env.WIKI_NO_AUTH;
});

describe("OPS-12 live web bridge", { concurrency: false }, () => {
test("session rejects unsupported extensions before starting an engine", async () => {
	await makeFile(workspaceA.rootDir, "notes.txt", "not a live web surface\n");
	const response = await sessionPOST(new Request(userUrl(workspaceA.workspace.id, "/api/wiki/live-web/session"), {
		method: "POST",
		headers: userHeaders(),
		body: JSON.stringify({ path: "notes.txt" }),
	}));
	assert.equal(response.status, 400);
	assert.equal((await response.json() as { error: string }).error, "UNSUPPORTED_SURFACE");
	assert.equal(getEngine({ workspaceId: workspaceA.workspace.id, relPath: "notes.txt" }), null);
});

test("accept without a ready scaffold returns NO_VARIANT and leaves disk unchanged", async () => {
	await startSession();
	const before = await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8");
	const response = await resolve(workspaceA.workspace.id, { action: "accept" });
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "NO_VARIANT");
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), before);
	assert.ok(getEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" }));
});

test("session start supervises scoped engine, creates scaffold, and enqueues exactly one variants request", async () => {
	const started = await startSession();
	assert.equal(getEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" })?.state, "running");
	const scaffold = scaffoldStore.getScaffold(started.scaffoldId);
	assert.ok(scaffold);
	assert.equal(scaffold.workspaceId, workspaceA.workspace.id);
	assert.equal(scaffold.relPath, "index.html");
	assert.equal(scaffold.state, "open");
	assert.equal(scaffold.originalSource, ORIGINAL);
	assert.equal(scaffold.diskBaseHash, sha256(ORIGINAL));

	queueEvent(started.port, { type: "generate", engineEventId: "evt-one", freeformPrompt: "make title blue", selector: "h1.title", tag: "h1" });
	const request = await waitFor(() => latestRequest(), (value) => !!value, "one queued request");
	assert.ok(request);
	assert.equal(request.kind, "web.tweak.variants");
	assert.equal(request.path, "index.html");
	assert.equal(previewStore.getPreview(request.previewId!)?.status, "requested");
	assert.equal(liveStore.latestRequest(liveStore.latestOpenSession(workspaceA.workspace.id)!.id)?.id, request.id);
	assert.equal(engineState(started.port).replies.length, 0);
});

test("second generate while first outstanding returns busy without a second enqueue", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-first", freeformPrompt: "first" });
	const first = await waitFor(() => latestRequest(), (value) => !!value, "first request");
	assert.ok(first);
	queueEvent(started.port, { type: "generate", engineEventId: "evt-second", freeformPrompt: "second" });
	const state = await waitFor(() => engineState(started.port), (value) => value.replies.some((reply) => reply.id === "evt-second"), "busy reply");
	const busy = state.replies.find((reply) => reply.id === "evt-second");
	assert.equal(busy?.type, "busy");
	assert.equal(latestRequest()!.id, first.id);
	assert.equal(previewStore.getPreview(first.previewId!)?.status, "requested");
});

test("duplicate engineEventId replays stored reply and creates no new request", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-replay", freeformPrompt: "variants" });
	const { requestId, previewId } = await attachScaffold(workspaceA.workspace.id);
	const firstDone = await waitFor(() => engineState(started.port).replies, (replies) => replies.some((reply) => reply.id === "evt-replay" && reply.type === "done"), "first done reply");
	const firstReply = firstDone.find((reply) => reply.id === "evt-replay" && reply.type === "done");
	assert.ok(firstReply);
	assert.equal(previewStore.getPreview(previewId)?.status, "preview-ready");
	assert.equal(latestRequest()!.id, requestId);

	queueEvent(started.port, { type: "generate", engineEventId: "evt-replay", freeformPrompt: "must not enqueue" });
	const replayed = await waitFor(() => engineState(started.port).replies, (replies) => replies.filter((reply) => reply.id === "evt-replay").length >= 2, "stored replay");
	const matching = replayed.filter((reply) => reply.id === "evt-replay");
	assert.equal(matching.length, 2);
	assert.deepEqual(matching[1], matching[0]);
	assert.equal(latestRequest()!.id, requestId);
});

test("agent scaffold reply becomes ready, engine gets done, accept carbonizes clean output, and tears down bridge", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-ready", freeformPrompt: "choose a title style" });
	const { previewId, scaffoldId } = await attachScaffold(workspaceA.workspace.id);
	const stored = await waitFor(() => scaffoldStore.getScaffold(scaffoldId), (value) => value?.state === "ready", "ready scaffold");
	assert.equal(stored?.scaffold, SCAFFOLD);
	assert.equal(stored?.scaffoldHash, sha256(SCAFFOLD));
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), ORIGINAL);
	const done = await waitFor(() => engineState(started.port).replies, (replies) => replies.some((reply) => reply.id === "evt-ready" && reply.type === "done"), "engine done");
	assert.equal(done.find((reply) => reply.id === "evt-ready")?.scaffold, SCAFFOLD);
	assert.equal(previewStore.getPreview(previewId)?.status, "preview-ready");

	const accepted = await resolve(workspaceA.workspace.id, { action: "accept", chosenVariantId: "blue", paramValues: { color: "green" } });
	assert.equal(accepted.status, 200);
	const output = await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8");
	assert.match(output, /Blue/);
	assert.match(output, /color: green/);
	assert.doesNotMatch(output, /impeccable|data-p-|--p-/i);
	assert.notEqual(output, ORIGINAL);
	assert.equal(scaffoldStore.getScaffold(scaffoldId)?.state, "accepted");
	assert.equal(getEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" }), null);
	assert.equal(bridge.getLiveBridgeStatus({ workspaceId: workspaceA.workspace.id, relPath: "index.html" }), null);
});

test("accept returns BASE_DRIFT and leaves drifted disk untouched", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-drift", freeformPrompt: "drift" });
	const { scaffoldId } = await attachScaffold(workspaceA.workspace.id);
	await waitFor(() => scaffoldStore.getScaffold(scaffoldId), (value) => value?.state === "ready", "ready scaffold");
	const drifted = `${ORIGINAL}<!-- human edit -->\n`;
	await writeFile(path.join(workspaceA.rootDir, "index.html"), drifted);
	const response = await resolve(workspaceA.workspace.id, { action: "accept", chosenVariantId: "red" });
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "BASE_DRIFT");
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), drifted);
	assert.equal(scaffoldStore.getScaffold(scaffoldId)?.state, "ready");
});

test("tampered scaffold or scaffold hash returns 409 and never writes", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-tamper", freeformPrompt: "tamper" });
	const { scaffoldId } = await attachScaffold(workspaceA.workspace.id);
	await waitFor(() => scaffoldStore.getScaffold(scaffoldId), (value) => value?.state === "ready", "ready scaffold");
	const before = await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8");
	const db = scaffoldStore.getDb();
	db.prepare("UPDATE live_web_scaffold SET scaffold = ?, scaffold_hash = ? WHERE id = ?").run(`${SCAFFOLD}\n<!-- tampered -->`, sha256(SCAFFOLD), scaffoldId);
	let response = await resolve(workspaceA.workspace.id, { action: "accept", chosenVariantId: "red" });
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "BASE_DRIFT");
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), before);

	db.prepare("UPDATE live_web_scaffold SET scaffold = ?, scaffold_hash = ? WHERE id = ?").run(SCAFFOLD, "tampered-hash", scaffoldId);
	response = await resolve(workspaceA.workspace.id, { action: "accept", chosenVariantId: "red" });
	assert.equal(response.status, 409);
	assert.equal((await response.json() as { error: string }).error, "BASE_DRIFT");
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), before);
});

test("discard leaves disk unchanged, closes ready scaffold, tears down engine, and isolates workspaces", async () => {
	const started = await startSession(workspaceA.workspace.id);
	queueEvent(started.port, { type: "generate", engineEventId: "evt-discard", freeformPrompt: "discard" });
	const { scaffoldId } = await attachScaffold(workspaceA.workspace.id);
	const activeScaffold = await waitFor(
		() => scaffoldStore.getScaffold(scaffoldId),
		(value) => value?.state === "ready",
		"ready scaffold before discard",
	);
	assert.ok(activeScaffold);
	const foreignStatus = await statusGET(new Request(userUrl(workspaceB.workspace.id, "/api/wiki/live-web/status", { path: "index.html" })));
	assert.equal(foreignStatus.status, 404);
	const before = await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8");
	const response = await resolve(workspaceA.workspace.id, { action: "discard" });
	assert.equal(response.status, 200);
	assert.equal(await readFile(path.join(workspaceA.rootDir, "index.html"), "utf8"), before);
	assert.equal(scaffoldStore.getScaffold(activeScaffold.id)?.state, "discarded");
	assert.equal(getEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" }), null);
	assert.equal(bridge.getLiveBridgeStatus({ workspaceId: workspaceA.workspace.id, relPath: "index.html" }), null);
	const foreignResolve = await resolve(workspaceB.workspace.id, { action: "accept", chosenVariantId: "red" });
	assert.equal(foreignResolve.status, 404);
});

test("status reports recoverable when engine is dead but open scaffold remains", async () => {
	const started = await startSession();
	await stopEngine({ workspaceId: workspaceA.workspace.id, relPath: "index.html" });
	const response = await statusGET(new Request(userUrl(workspaceA.workspace.id, "/api/wiki/live-web/status", { path: "index.html" })));
	assert.equal(response.status, 200);
	const body = await response.json() as { engine: unknown; engineLive: boolean; recoverable: boolean; scaffold: { state: string } };
	assert.equal(body.engine, null);
	assert.equal(body.engineLive, false);
	assert.equal(body.recoverable, true);
	assert.equal(body.scaffold.state, "open");
});

test("missing scaffold reply sends durable engine error and keeps scaffold open", async () => {
	const started = await startSession();
	queueEvent(started.port, { type: "generate", engineEventId: "evt-missing", freeformPrompt: "no scaffold" });
	const preview = await waitForPreview(workspaceA.workspace.id);
	assert.ok(preview.requestId);
	const response = await webPreviewPOST(new Request(userUrl(workspaceA.workspace.id, "/api/agent/live/web-preview"), {
		method: "POST",
		headers: agentHeaders(workspaceA.workspace.id),
		body: JSON.stringify({
			previewId: preview.id,
			requestId: preview.requestId,
			status: "done",
			variants: [
				{ variantId: "red", label: "Red", domPreviewOps: [], candidateSourcePatch: null, baseFiles: [] },
				{ variantId: "blue", label: "Blue", domPreviewOps: [], candidateSourcePatch: null, baseFiles: [] },
			],
		}),
	}));
	assert.equal(response.status, 200);
	const replies = await waitFor(() => engineState(started.port).replies, (value) => value.some((reply) => reply.id === "evt-missing" && reply.type === "error"), "missing scaffold error");
	assert.match(String(replies.find((reply) => reply.id === "evt-missing")?.message), /scaffold/i);
	const activeScaffold = scaffoldStore.getLatestScaffold(workspaceA.workspace.id, "index.html");
	assert.equal(activeScaffold?.state, "open");
});
});
