/**
 * Server-side singleton that manages child processes for node-app directories.
 * Lives as a module-level Map so it persists across requests in both dev and
 * the Next.js standalone production server.
 */
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import path from "node:path";

export type AppStatus = "stopped" | "installing" | "starting" | "running" | "error";

interface RunningApp {
	port: number;
	process: ChildProcess | null;
	status: AppStatus;
	error?: string;
	logs: string[];
}

// ── singleton ────────────────────────────────────────────────────────────────
const apps = new Map<string, RunningApp>();

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
		sock.on("error",   () => { sock.destroy(); resolve(false); });
		sock.on("timeout", () => { sock.destroy(); resolve(false); });
	});
}

// Probe both IPv4 (127.0.0.1) and IPv6 (::1) — Vite binds to ::1 by default.
async function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [v4, v6] = await Promise.all([
			canConnect(port, "127.0.0.1"),
			canConnect(port, "::1"),
		]);
		if (v4 || v6) return true;
		await new Promise((r) => setTimeout(r, 400));
	}
	return false;
}

type PM = "npm" | "pnpm" | "yarn";

function detectPM(dir: string): PM {
	if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
	if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
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

/**
 * Default script chosen when the user doesn't pick one explicitly.
 * Priority: start > preview (built) > dev.
 */
function defaultScript(dir: string, scripts: Record<string, string>): string | null {
	if (scripts.start) return "start";
	if (scripts.preview && existsSync(path.join(dir, "dist"))) return "preview";
	if (scripts.dev) return "dev";
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

function detectCmd(dir: string, pm: PM, script?: string): Cmd | null {
	const pkg = readPkg(dir);
	if (!pkg) return null;

	const scripts = pkg.scripts ?? {};
	const hasVite = hasViteDep(pkg);

	const run = (s: string, extraArgs: string[] = []): Cmd => ({
		bin: pm,
		args: ["run", s, ...(extraArgs.length ? ["--", ...extraArgs] : [])],
		isVite: hasVite,
	});

	// Explicit script choice wins
	if (script && scripts[script]) return run(script);

	const def = defaultScript(dir, scripts);
	if (def) return run(def);
	if (pkg.main) return { bin: "node", args: [pkg.main], isVite: false };
	return null;
}

function needsInstall(dir: string): boolean {
	return !existsSync(path.join(dir, "node_modules"));
}

function runInstall(dir: string, pm: PM): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(pm, ["install"], { cwd: dir, stdio: "pipe" });
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${pm} install failed (exit ${code})`))));
		child.on("error", reject);
	});
}

// ── public API ───────────────────────────────────────────────────────────────

export function getStatus(relPath: string): { status: AppStatus; port?: number; error?: string; logs: string[] } {
	const app = apps.get(relPath);
	if (!app) return { status: "stopped", logs: [] };
	return { status: app.status, port: app.port || undefined, error: app.error, logs: app.logs };
}

export async function startApp(relPath: string, absPath: string, script?: string): Promise<{ port: number }> {
	const existing = apps.get(relPath);
	if (existing && existing.status !== "stopped" && existing.status !== "error") {
		return { port: existing.port };
	}

	const port = await findFreePort();
	const pm = detectPM(absPath);
	const cmd = detectCmd(absPath, pm, script);
	if (!cmd) throw new Error("No runnable script found in package.json (need start, preview, or dev)");

	const entry: RunningApp = { port, process: null, status: "installing", logs: [] };
	apps.set(relPath, entry);

	const pushLog = (line: string) => {
		entry.logs.push(line);
		if (entry.logs.length > 200) entry.logs.shift();
	};

	// Install if needed
	if (needsInstall(absPath)) {
		try {
			pushLog(`[wiki-viewer] Running ${pm} install…`);
			await runInstall(absPath, pm);
		} catch (e) {
			entry.status = "error";
			entry.error = String(e);
			return { port };
		}
	}

	entry.status = "starting";
	pushLog(`[wiki-viewer] Starting on port ${port}: ${cmd.bin} ${cmd.args.join(" ")}`);

	const portArgs = cmd.isVite ? ["--port", String(port)] : [];
	const child = spawn(cmd.bin, [...cmd.args, ...portArgs], {
		cwd: absPath,
		stdio: "pipe",
		env: {
			...process.env,
			PORT: String(port),
			VITE_PORT: String(port),
		},
	});
	entry.process = child;

	const handleOutput = (data: Buffer) => {
		for (const line of data.toString().split("\n")) {
			if (line.trim()) pushLog(line);
		}
	};
	child.stdout?.on("data", handleOutput);
	child.stderr?.on("data", handleOutput);

	child.on("exit", (code) => {
		const a = apps.get(relPath);
		if (a?.process === child) {
			a.status = code === 0 || code === null ? "stopped" : "error";
			a.error = code ? `Process exited with code ${code}` : undefined;
		}
	});

	// Wait for port in background
	waitForPort(port).then((ok) => {
		const a = apps.get(relPath);
		if (a?.process === child) {
			a.status = ok ? "running" : "error";
			if (!ok) a.error = "Port never became reachable (30 s timeout)";
		}
	});

	return { port };
}

export function stopApp(relPath: string): void {
	const app = apps.get(relPath);
	if (!app?.process) return;
	try {
		app.process.kill("SIGTERM");
	} catch {}
	app.status = "stopped";
}

export function listApps(): Array<{ relPath: string; status: AppStatus; port?: number }> {
	return [...apps.entries()].map(([relPath, a]) => ({
		relPath,
		status: a.status,
		port: a.port || undefined,
	}));
}

/**
 * Given URL path segments, find the longest prefix that matches a running app.
 * e.g. ["apps", "roadmap-server", "api", "specs"] → { relPath: "apps/roadmap-server", port, rest: "/api/specs" }
 */
export function resolveByPrefix(
	segments: string[],
): { relPath: string; port: number; rest: string } | null {
	for (let i = segments.length; i > 0; i--) {
		const relPath = segments.slice(0, i).join("/");
		const app = apps.get(relPath);
		if (app && app.status === "running" && app.port) {
			const rest = "/" + segments.slice(i).join("/");
			return { relPath, port: app.port, rest };
		}
	}
	return null;
}
