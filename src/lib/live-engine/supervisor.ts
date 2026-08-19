import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { createConnection, createServer } from "node:net";
import { liveEngineKey, liveServerScript, type LiveEngineKey } from "./paths";
import { LiveEngineClient } from "./client";

export type LiveEngineState = "starting" | "running" | "stopped" | "error";

export interface StartEngineInput extends LiveEngineKey {
	appRoot: string;
}

export interface LiveEngineInfo extends StartEngineInput {
	port: number;
	token: string;
	state: LiveEngineState;
	generation: number;
}

interface EngineEntry extends LiveEngineInfo {
	process: ChildProcess | null;
	abort: AbortController;
	ready: Promise<LiveEngineInfo>;
}

export type EngineSpawner = (
	file: string,
	args: string[],
	options: SpawnOptions,
) => ChildProcess;

const defaultSpawner: EngineSpawner = (file, args, options) => spawn(file, args, options);
let spawner: EngineSpawner = defaultSpawner;

/** Replace process creation in tests; pass null to restore real spawning. */
export function __setSpawnerForTest(next: EngineSpawner | null): void {
	spawner = next ?? defaultSpawner;
}

const engines = new Map<string, EngineEntry>();
const generations = new Map<string, number>();

function keyOf(key: LiveEngineKey): string {
	return liveEngineKey(key);
}

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close((error) => (error ? reject(error) : resolve(port)));
		});
	});
}

function probe(port: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve(false);
			return;
		}
		const socket = createConnection(port, "127.0.0.1");
		const finish = (result: boolean) => {
			socket.destroy();
			resolve(result);
		};
		socket.setTimeout(800);
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
		socket.once("timeout", () => finish(false));
		signal.addEventListener("abort", () => finish(false), { once: true });
	});
}

function isCurrent(key: string, entry: EngineEntry): boolean {
	return (
		engines.get(key) === entry &&
		generations.get(key) === entry.generation &&
		!entry.abort.signal.aborted
	);
}

function toPublic(entry: EngineEntry): LiveEngineInfo {
	return {
		workspaceId: entry.workspaceId,
		relPath: entry.relPath,
		appRoot: entry.appRoot,
		port: entry.port,
		token: entry.token,
		state: entry.state,
		generation: entry.generation,
	};
}

function parseConnection(line: string): { port: number; token: string } | null {
	try {
		const value = JSON.parse(line) as {
			port?: unknown;
			token?: unknown;
			serverPort?: unknown;
			serverToken?: unknown;
		};
		const port = value.port ?? value.serverPort;
		const token = value.token ?? value.serverToken;
		if (typeof port !== "number" || !Number.isInteger(port)) return null;
		if (typeof token !== "string" || token.length === 0) return null;
		return { port, token };
	} catch {
		return null;
	}
}

function waitForConnection(
	child: ChildProcess,
	entry: EngineEntry,
	key: string,
): Promise<{ port: number; token: string }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stdout = "";
		const finish = (error?: Error, connection?: { port: number; token: string }) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else if (connection) resolve(connection);
		};
		const onData = (data: Buffer) => {
			stdout += data.toString("utf8");
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				const connection = parseConnection(line.trim());
				if (connection) {
					finish(undefined, connection);
					return;
				}
			}
		};
		child.stdout?.on("data", onData);
		child.once("error", (error) => finish(error));
		child.once("exit", (code) => {
			if (settled || entry.abort.signal.aborted || !isCurrent(key, entry)) return;
			finish(new Error(`Live engine exited before startup (code ${code ?? "unknown"})`));
		});
		entry.abort.signal.addEventListener(
			"abort",
			() => finish(new Error("Live engine startup aborted")),
			{ once: true },
		);
	});
}

async function waitUntilHealthy(entry: EngineEntry, key: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (!isCurrent(key, entry)) throw new Error("Live engine startup superseded");
		if (await probe(entry.port, entry.abort.signal)) {
			try {
				const health = await new LiveEngineClient(entry).health(entry.abort.signal);
				if (health.status === "ok") return;
			} catch {
				/* helper may be listening before its health handler is ready */
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error("Live engine health check timed out");
}

async function startEntry(entry: EngineEntry, key: string): Promise<LiveEngineInfo> {
	try {
		const child = spawner(process.execPath, [liveServerScript(), "--background", `--port=${entry.port}`], {
			cwd: entry.appRoot,
			stdio: ["ignore", "pipe", "ignore"],
			env: { ...process.env },
		});
		entry.process = child;
		const connection = await waitForConnection(child, entry, key);
		if (!isCurrent(key, entry)) throw new Error("Live engine startup superseded");
		entry.port = connection.port;
		entry.token = connection.token;
		await waitUntilHealthy(entry, key);
		if (!isCurrent(key, entry)) throw new Error("Live engine startup superseded");
		entry.state = "running";
		return toPublic(entry);
	} catch (error) {
		if (engines.get(key) === entry) {
			entry.state = "error";
			engines.delete(key);
		}
		throw error;
	}
}

/** Start or reuse one helper server for a workspace-relative surface. */
export async function startEngine(input: StartEngineInput): Promise<LiveEngineInfo> {
	const key = keyOf(input);
	const existing = engines.get(key);
	if (existing && (existing.state === "running" || existing.state === "starting")) {
		return existing.state === "running" ? toPublic(existing) : existing.ready;
	}
	if (existing) await stopEngine(input);

	const generation = (generations.get(key) ?? 0) + 1;
	generations.set(key, generation);
	const entry: EngineEntry = {
		...input,
		port: await findFreePort(),
		token: "",
		state: "starting",
		generation,
		process: null,
		abort: new AbortController(),
		ready: Promise.resolve(undefined as never),
	};
	engines.set(key, entry);
	entry.ready = startEntry(entry, key);
	return entry.ready;
}

/** Return current lifecycle state, including the browser connection token. */
export function getEngine(key: LiveEngineKey): LiveEngineInfo | null {
	const entry = engines.get(keyOf(key));
	return entry ? toPublic(entry) : null;
}

/** Stop helper server, cancel stale supervision, and remove its entry. */
export async function stopEngine(keyInput: LiveEngineKey): Promise<void> {
	const key = keyOf(keyInput);
	const entry = engines.get(key);
	if (!entry) return;
	entry.abort.abort();
	engines.delete(key);

	if (entry.token) {
		try {
			await new LiveEngineClient(entry).stop();
		} catch {
			/* process teardown below remains authoritative */
		}
	}

	const child = entry.process;
	entry.process = null;
	if (!child) return;
	try {
		if (!child.killed && child.pid) child.kill("SIGTERM");
	} catch {
		/* already exited */
	}
}
