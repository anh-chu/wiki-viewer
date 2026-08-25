/**
 * Server-side singleton that manages child processes for node-app directories.
 * Lives as a module-level Map so it persists across requests in both dev and
 * the Next.js standalone production server.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { watch, type FSWatcher } from "chokidar";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import {
	DEFAULT_CRASH_RESTART_CAP,
	initialSupervisionState,
	reduceSupervision,
	type SupervisionState,
} from "./app-supervisor";
import { listHostedApps } from "./hosted-apps";
import { getWorkspace, safeWorkspacePath } from "./workspaces";

export type AppStatus = "stopped" | "installing" | "starting" | "running" | "error";
type RunnerStatus = AppStatus | "restarting" | "missing";

interface AppKey {
	workspaceId: string;
	relPath: string;
}

interface RunningApp {
	workspaceId: string;
	relPath: string;
	absPath: string;
	script?: string;
	port: number;
	process: ChildProcess | null;
	status: RunnerStatus;
	error?: string;
	logs: string[];
	/** Generation token: only the current generation may update readiness/exit state. */
	generation: number;
	/** Cancels readiness polling and signals the install child to terminate. */
	abort: AbortController;
	/** Persisted apps are supervised and restarted on crashes/source changes. */
	persist: boolean;
	supervision: SupervisionState;
	watcher: FSWatcher | null;
	restartTimer: ReturnType<typeof setTimeout> | null;
}

// ── singleton ────────────────────────────────────────────────────────────────

const apps = new Map<string, RunningApp>();
const missingApps = new Set<string>();
const restartStates = new Map<string, SupervisionState>();

function keyOf(key: AppKey): string {
	return `${key.workspaceId}\0${key.relPath}`;
}

function isSupervised(entry: RunningApp): boolean {
	return entry.persist;
}

function closeWatcher(entry: RunningApp): void {
	const watcher = entry.watcher;
	entry.watcher = null;
	if (watcher) void watcher.close();
}

function stopChild(entry: RunningApp): void {
	const child = entry.process;
	entry.process = null;
	if (!child) return;
	try {
		if (!child.killed && child.pid) child.kill("SIGTERM");
	} catch {}
	const killLater = setTimeout(() => {
		try {
			if (!child.killed && child.pid) child.kill("SIGKILL");
		} catch {}
	}, 2000);
	child.once("exit", () => clearTimeout(killLater));
}

// ── helpers ──────────────────────────────────────────────────────────────────

function findFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolve(port));
		});
		s.on("error", reject);
	});
}

function canConnect(port: number, host: string): Promise<boolean> {
	return new Promise((resolve) => {
		const sock = createConnection(port, host);
		sock.setTimeout(800);
		sock.on("connect", () => { sock.destroy(); resolve(true); });
		sock.on("error", () => { sock.destroy(); resolve(false); });
		sock.on("timeout", () => { sock.destroy(); resolve(false); });
	});
}

// Probe both IPv4 (127.0.0.1) and IPv6 (::1) — Vite binds to ::1 by default.
async function probe(port: number): Promise<boolean> {
	const [v4, v6] = await Promise.all([
		canConnect(port, "127.0.0.1"),
		canConnect(port, "::1"),
	]);
	return v4 || v6;
}

// Wait until the assigned port becomes reachable.
// Returns the reachable port, or null on timeout/abort.
async function waitForApp(entry: RunningApp, timeoutMs = 30_000): Promise<number | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (entry.abort.signal.aborted) return null;
		if (await probe(entry.port)) return entry.port;
		await new Promise((r) => setTimeout(r, 400));
	}
	return null;
}

type PM = "npm" | "pnpm" | "yarn" | "bun";

function detectPM(dir: string): PM {
	if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
	if (existsSync(path.join(dir, "bun.lockb")) || existsSync(path.join(dir, "bun.lock"))) return "bun";
	return "npm";
}

interface Cmd {
	bin: string;
	args: string[];
	isVite: boolean;
}

interface Pkg {
	scripts?: Record<string, string>;
	main?: string;
	dependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

function readPkg(dir: string): Pkg | null {
	const pkgPath = path.join(dir, "package.json");
	if (!existsSync(pkgPath)) return null;
	try {
		return JSON.parse(readFileSync(pkgPath, "utf-8")) as Pkg;
	} catch {
		return null;
	}
}

function hasViteDep(pkg: Pkg): boolean {
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
	return Object.keys(allDeps).some((k) => k === "vite" || k.includes("vite"));
}

function hasScript(scripts: Record<string, string>, name: string): boolean {
	return Object.prototype.hasOwnProperty.call(scripts, name);
}

/**
 * Default script chosen when the user doesn't pick one explicitly.
 * Priority: start > preview (built) > dev.
 */
function defaultScript(dir: string, scripts: Record<string, string>): string | null {
	if (hasScript(scripts, "start")) return "start";
	if (hasScript(scripts, "preview") && existsSync(path.join(dir, "dist"))) return "preview";
	if (hasScript(scripts, "dev")) return "dev";
	return null;
}

/**
 * List the npm scripts available to launch, plus which one is the default.
 * Returns empty scripts list when only `main` is runnable (node entry).
 */
export function getScripts(absPath: string): { scripts: string[]; defaultScript: string | null } {
	const pkg = readPkg(absPath);
	if (!pkg) return { scripts: [], defaultScript: null };
	const scripts = pkg.scripts ?? {};
	return {
		scripts: Object.keys(scripts),
		defaultScript: defaultScript(absPath, scripts),
	};
}

function detectCmd(dir: string, pm: PM, port: number, script?: string): Cmd | null {
	const pkg = readPkg(dir);
	if (!pkg) return null;

	const scripts = pkg.scripts ?? {};
	const hasVite = hasViteDep(pkg);

	// `--port <n>` is the dominant convention for local dev/preview servers
	// (vite, next, and most ad-hoc `node server.mjs --port` scripts). We inject
	// it for every app — combined with the PORT/VITE_PORT env vars set at spawn,
	// this covers both arg-driven and env-driven servers. Apps that don't accept
	// the flag almost always ignore unknown argv harmlessly.
	const portArgs = ["--port", String(port)];

	// npm strips the first `--` and forwards the rest to the script; pnpm/yarn
	// forward the literal `--` through, which makes arg parsers (e.g. commander)
	// treat `--port N` as positional operands and ignore them. So only npm gets
	// the separator.
	const run = (s: string): Cmd => ({
		bin: pm,
		args: pm === "npm" ? ["run", s, "--", ...portArgs] : ["run", s, ...portArgs],
		isVite: hasVite,
	});

	// Explicit script choice wins. Validate by own-property lookup only.
	if (script) {
		if (!hasScript(scripts, script)) return null;
		return run(script);
	}

	const def = defaultScript(dir, scripts);
	if (def) return run(def);
	if (pkg.main) return { bin: "node", args: [pkg.main, ...portArgs], isVite: false };
	return null;
}

function needsInstall(dir: string): boolean {
	return !existsSync(path.join(dir, "node_modules"));
}

/**
 * PATH guaranteed to contain the package-manager shims (npm/pnpm/yarn/npx),
 * which live in the same bin dir as the running node executable. Makes
 * `spawn("npm")` work regardless of how the server was launched (systemd unit,
 * detached daemon, fnm/nvm shell) — fixes "spawn npm ENOENT".
 */
function spawnPath(): string {
	const nodeBin = path.dirname(process.execPath);
	const existing = process.env.PATH ?? "";
	return existing.split(path.delimiter).includes(nodeBin)
		? existing
		: `${nodeBin}${path.delimiter}${existing}`;
}

function runInstall(
	dir: string,
	pm: PM,
	pushLog: (line: string) => void,
	signal: AbortSignal,
): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Install aborted"));
			return;
		}

		const local: string[] = [];
		const log = (line: string) => {
			pushLog(line);
			local.push(line);
		};

		const child = spawn(pm, ["install"], {
			cwd: dir,
			stdio: "pipe",
			env: { ...process.env, PATH: spawnPath() },
		});

		const onAbort = () => {
			try { child.kill("SIGTERM"); } catch {}
		};
		signal.addEventListener("abort", onAbort, { once: true });

		const drain = (data: Buffer) => {
			for (const line of data.toString().split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				log(trimmed);
			}
		};
		child.stdout?.on("data", drain);
		child.stderr?.on("data", drain);

		child.on("error", (err) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		});
		child.on("exit", (code) => {
			signal.removeEventListener("abort", onAbort);
			if (code === 0) {
				resolve();
			} else {
				const tail = local.slice(-20).join("\n");
				reject(new Error(`${pm} install failed (exit ${code}):\n${tail}`));
			}
		});
	});
}

function scheduleSupervisedRestart(entry: RunningApp, key: string): void {
	if (entry.restartTimer || entry.abort.signal.aborted) return;
	restartStates.set(key, entry.supervision);
	entry.restartTimer = setTimeout(() => {
		entry.restartTimer = null;
		if (apps.get(key) !== entry || entry.abort.signal.aborted || entry.supervision.status === "error") return;
		void startApp(entry.workspaceId, entry.relPath, entry.absPath, entry.script, { persist: true }).catch(() => {});
	}, 250);
}

function armWatcher(entry: RunningApp, key: string): void {
	if (!entry.persist || entry.watcher) return;
	entry.watcher = watch(entry.absPath, {
		ignoreInitial: true,
		ignored: (candidate) => path.relative(entry.absPath, candidate).split(path.sep).some((part) => ["node_modules", ".git", ".next"].includes(part)),
		awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
	});
	entry.watcher.on("all", () => {
		if (apps.get(key) !== entry || entry.abort.signal.aborted) return;
		const result = reduceSupervision(entry.supervision, { type: "file-change" });
		entry.supervision = result.state;
		if (result.action === "restart") {
			stopChild(entry);
			entry.status = "restarting";
			scheduleSupervisedRestart(entry, key);
		}
	});
}

// ── public API ───────────────────────────────────────────────────────────────

export function getStatus(
	workspaceId: string,
	relPath: string,
): {
	status: RunnerStatus;
	port?: number;
	error?: string;
	lastError?: string;
	restartCount?: number;
	fileWatchRestartCount?: number;
	logs: string[];
} {
	const app = apps.get(keyOf({ workspaceId, relPath }));
	if (!app) {
		return missingApps.has(keyOf({ workspaceId, relPath }))
			? { status: "missing", error: "Hosted app source directory is missing", logs: [] }
			: { status: "stopped", logs: [] };
	}
	return {
		status: app.status,
		port: app.port || undefined,
		error: app.error,
		lastError: app.supervision.lastError ?? app.error,
		restartCount: app.supervision.crashCount,
		fileWatchRestartCount: app.supervision.fileWatchRestartCount,
		logs: app.logs,
	};
}

export async function startApp(
	workspaceId: string,
	relPath: string,
	absPath: string,
	script?: string,
	options?: { persist?: boolean },
): Promise<{ port: number }> {
	const key = keyOf({ workspaceId, relPath });
	const persist = options?.persist === true;

	const existing = apps.get(key);
	if (existing && existing.status !== "stopped" && existing.status !== "error" && existing.status !== "missing" && existing.process) {
		if (persist) existing.persist = true;
		return { port: existing.port };
	}
	if (existing) {
		existing.abort.abort();
		if (existing.restartTimer) clearTimeout(existing.restartTimer);
		closeWatcher(existing);
		stopChild(existing);
		apps.delete(key);
	}
	missingApps.delete(key);

	const port = await findFreePort();
	const pm = detectPM(absPath);
	const cmd = detectCmd(absPath, pm, port, script);
	if (!cmd) throw new Error("No runnable script found in package.json (need start, preview, or dev)");

	const priorSupervision = restartStates.get(key);
	restartStates.delete(key);
	const entry: RunningApp = {
		workspaceId,
		relPath,
		absPath,
		script,
		port,
		process: null,
		status: "installing",
		logs: [],
		generation: 1,
		abort: new AbortController(),
		persist: false,
		supervision: priorSupervision ?? initialSupervisionState(),
		watcher: null,
		restartTimer: null,
	};
	apps.set(key, entry);

	const pushLog = (line: string) => {
		entry.logs.push(line);
		if (entry.logs.length > 200) entry.logs.shift();
	};

	try {
		if (needsInstall(absPath)) {
			pushLog(`[wiki-viewer] Running ${pm} install…`);
			await runInstall(absPath, pm, pushLog, entry.abort.signal);
		}

		entry.status = "starting";
		pushLog(`[wiki-viewer] Starting on port ${port}: ${cmd.bin} ${cmd.args.join(" ")}`);

		const child = spawn(cmd.bin, cmd.args, {
			cwd: absPath,
			stdio: "pipe",
			env: {
				...process.env,
				PATH: spawnPath(),
				PORT: String(port),
				VITE_PORT: String(port),
			},
		});
		entry.process = child;

		const handleOutput = (data: Buffer) => {
			for (const line of data.toString().split("\n")) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				pushLog(trimmed);
			}
		};
		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);

		child.on("exit", (code) => {
			// Only the current entry may update state, and never after an explicit stop.
			if (apps.get(key) !== entry) return;
			if (entry.status === "stopped" || entry.abort.signal.aborted) return;
			entry.process = null;
			if (entry.persist && code !== 0 && code !== null) {
				const result = reduceSupervision(entry.supervision, { type: "crash", detail: `exit ${code}` });
				entry.supervision = result.state;
				if (result.action === "restart") {
					entry.status = "restarting";
					scheduleSupervisedRestart(entry, key);
				} else {
					entry.status = "error";
					entry.error = entry.supervision.lastError;
				}
				return;
			}
			entry.status = code === 0 || code === null ? "stopped" : "error";
			entry.error = code ? `Process exited with code ${code}` : undefined;
		});

		waitForApp(entry).then((reachable) => {
			if (apps.get(key) !== entry) return;
			if (entry.abort.signal.aborted) return;
			if (reachable) {
				entry.status = "running";
				entry.supervision = { ...entry.supervision, status: "running" };
				armWatcher(entry, key);
			} else if (entry.persist) {
				const result = reduceSupervision(entry.supervision, { type: "crash", detail: "readiness timeout" });
				entry.supervision = result.state;
				if (result.action === "restart") {
					entry.status = "restarting";
					scheduleSupervisedRestart(entry, key);
				} else {
					entry.status = "error";
					entry.error = entry.supervision.lastError;
				}
				try { child.kill("SIGTERM"); } catch {}
			} else {
				entry.status = "error";
				entry.error = "Port never became reachable (30 s timeout)";
				try { child.kill("SIGTERM"); } catch {}
			}
		});

		return { port };
	} catch (e) {
		if (apps.get(key) === entry) {
			entry.status = "error";
			entry.error = e instanceof Error ? e.message : String(e);
		}
		throw e;
	}
}

export async function restartApp(
	workspaceId: string,
	relPath: string,
	absPath: string,
	script?: string,
	persist = true,
): Promise<{ port: number }> {
	const key = keyOf({ workspaceId, relPath });
	const entry = apps.get(key);
	if (!entry) return startApp(workspaceId, relPath, absPath, script, { persist });
	entry.supervision = reduceSupervision(entry.supervision, { type: "manual-restart" }).state;
	entry.persist = persist;
	entry.absPath = absPath;
	entry.script = script;
	if (entry.restartTimer) clearTimeout(entry.restartTimer);
	entry.restartTimer = null;
	stopChild(entry);
	entry.status = "restarting";
	scheduleSupervisedRestart(entry, key);
	return { port: entry.port };
}

export function setAppPersistence(
	workspaceId: string,
	relPath: string,
	absPath: string,
	persist: boolean,
): void {
	const key = keyOf({ workspaceId, relPath });
	const entry = apps.get(key);
	if (!entry) return;
	entry.persist = persist;
	entry.absPath = absPath;
	if (persist) armWatcher(entry, key);
	else closeWatcher(entry);
}

export function stopApp(workspaceId: string, relPath: string): void {
	const key = keyOf({ workspaceId, relPath });
	const entry = apps.get(key);
	if (!entry) return;

	entry.abort.abort();
	if (entry.restartTimer) clearTimeout(entry.restartTimer);
	entry.restartTimer = null;
	closeWatcher(entry);
	entry.status = "stopped";
	apps.delete(key);
	stopChild(entry);
}

/**
 * Given URL path segments, find the longest prefix that matches a running app
 * in the requested workspace.
 * e.g. ["apps", "roadmap-server", "api", "specs"] → { relPath: "apps/roadmap-server", port, rest: "/api/specs" }
 */
export function resolveByPrefix(
	workspaceId: string,
	segments: string[],
): { relPath: string; port: number; rest: string } | null {
	for (let i = segments.length; i > 0; i--) {
		const relPath = segments.slice(0, i).join("/");
		const app = apps.get(keyOf({ workspaceId, relPath }));
		if (app && app.status === "running" && app.port) {
			const rest = "/" + segments.slice(i).join("/");
			return { relPath, port: app.port, rest };
		}
	}
	return null;
}

/** Restore pinned node apps only when unattended host-code execution is opted in. */
export async function restorePersistedApps(): Promise<void> {
	if (process.env.WIKI_NO_AUTH !== "1" && process.env.WIKI_ALLOW_APP_RUNNER !== "1") return;
	const persisted = (await listHostedApps()).filter((app) => app.type === "node" && app.persist === true);
	for (const app of persisted) {
		const key = keyOf({ workspaceId: app.workspaceId, relPath: app.relPath });
		const ws = await getWorkspace(app.workspaceId);
		const abs = ws ? safeWorkspacePath(ws.rootDir, app.relPath) : null;
		if (!abs || !existsSync(abs)) {
			missingApps.add(key);
			continue;
		}
		try {
			await startApp(app.workspaceId, app.relPath, abs, app.script, { persist: true });
		} catch {
			// getStatus exposes the runner's error/log buffer; one bad pinned app
			// must not prevent other persisted apps from restoring.
		}
	}
}

if (process.env.WIKI_NO_AUTH === "1" || process.env.WIKI_ALLOW_APP_RUNNER === "1") {
	void restorePersistedApps();
}
