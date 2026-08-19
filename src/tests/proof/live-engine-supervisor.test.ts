import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, type Server } from "node:http";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { POST, DELETE } from "../../app/api/wiki/live-web/session/route.js";
import { LiveEngineClient } from "../../lib/live-engine/client.js";
import {
	__setSpawnerForTest,
	getEngine,
	startEngine,
	stopEngine,
} from "../../lib/live-engine/supervisor.js";
import { createTestWorkspace } from "./helpers/workspace.js";

class StubChild extends EventEmitter {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = Math.floor(Math.random() * 100_000) + 1;
	killed = false;
	constructor(readonly server: Server) {
		super();
	}
	kill(): boolean {
		this.killed = true;
		this.server.close();
		this.emit("exit", 0, null);
		return true;
	}
}

let workspace: Awaited<ReturnType<typeof createTestWorkspace>>;
let previousNoAuth: string | undefined;
let generation = 0;
let delayedHealth = false;
const children = new Set<StubChild>();

function stubSpawner(_file: string, args: string[]): StubChild {
	const portArg = args.find((arg) => arg.startsWith("--port="));
	const port = Number(portArg?.slice("--port=".length));
	const token = `stub-token-${++generation}`;
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		if (url.searchParams.get("token") !== token && url.pathname !== "/health") {
			response.writeHead(401);
			response.end();
			return;
		}
		if (url.pathname === "/health") {
			const send = () => {
				response.writeHead(200, { "Content-Type": "application/json" });
				response.end(JSON.stringify({ status: "ok", port }));
			};
			if (delayedHealth) {
				delayedHealth = false;
				setTimeout(send, 250);
			} else send();
			return;
		}
		if (url.pathname === "/poll" && request.method === "GET") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ type: "timeout" }));
			return;
		}
		if (url.pathname === "/poll" && request.method === "POST") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ ok: true }));
			return;
		}
		if (url.pathname === "/status") {
			response.writeHead(200, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ status: "ok" }));
			return;
		}
		if (url.pathname === "/stop") {
			response.writeHead(200);
			response.end("stopping");
			return;
		}
		response.writeHead(404);
		response.end();
	});
	const child = new StubChild(server);
	children.add(child);
	server.listen(port, "127.0.0.1", () => {
		child.stdout.write(`${JSON.stringify({ pid: child.pid, port, token })}\n`);
	});
	return child;
}

function sessionRequest(method: "POST" | "DELETE", path: string): Request {
	return new Request(`http://localhost:3000/api/wiki/live-web/session?ws=${workspace.workspace.id}`, {
		method,
		headers: {
			Origin: "http://localhost:3000",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ path }),
	});
}

before(async () => {
	previousNoAuth = process.env.WIKI_NO_AUTH;
	process.env.WIKI_NO_AUTH = "1";
	workspace = await createTestWorkspace({ name: "live-engine-supervisor" });
	await mkdir(`${workspace.rootDir}/app`, { recursive: true });
	await writeFile(`${workspace.rootDir}/app/index.html`, "<h1>stub</h1>");
	__setSpawnerForTest(stubSpawner as never);
});

after(async () => {
	await stopEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" });
	for (const child of children) child.kill();
	__setSpawnerForTest(null);
	if (previousNoAuth === undefined) delete process.env.WIKI_NO_AUTH;
	else process.env.WIKI_NO_AUTH = previousNoAuth;
	await rm(workspace.rootDir, { recursive: true, force: true });
});

test("session route starts helper and typed client reaches health", async () => {
	const response = await POST(sessionRequest("POST", "app/index.html"));
	assert.equal(response.status, 200);
	const body = (await response.json()) as { port: number; token: string };
	assert.equal(typeof body.port, "number");
	assert.equal(typeof body.token, "string");
	const health = await new LiveEngineClient(body).health();
	assert.equal(health.status, "ok");
	assert.equal(getEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" })?.state, "running");
});

test("stopping and restarting invalidates stale supervision generation", async () => {
	await stopEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" });
	delayedHealth = true;
	const staleStart = startEngine({
		workspaceId: workspace.workspace.id,
		relPath: "app/index.html",
		appRoot: `${workspace.rootDir}/app`,
	});
	await new Promise((resolve) => setTimeout(resolve, 30));
	await stopEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" });
	await assert.rejects(staleStart);

	const response = await POST(sessionRequest("POST", "app/index.html"));
	assert.equal(response.status, 200);
	const current = getEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" });
	assert.equal(current?.state, "running");
	assert.equal(current?.generation, 3);
});

test("session route DELETE tears down helper and clears entry", async () => {
	const response = await DELETE(sessionRequest("DELETE", "app/index.html"));
	assert.equal(response.status, 200);
	assert.equal(getEngine({ workspaceId: workspace.workspace.id, relPath: "app/index.html" }), null);
});
