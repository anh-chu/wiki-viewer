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

function waitForPort(port: number, timeoutMs = 30_000): Promise<boolean> {
	return new Promise((resolve) => {
		const deadline = Date.now() + timeoutMs;
		const attempt = () => {
			const sock = createConnection(port, "127.0.0.1");
			sock.setTimeout(1_000);
			sock.on("connect", () => {
				sock.destroy();
				resolve(true);
			});
			const fail = () => {
				sock.destroy();
				if (Date.now() >= deadline) resolve(false);
				else setTimeout(attempt, 600);
			};
			sock.on("error", fail);
			sock.on("timeout", fail);
		};
		attempt();
	});
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

function detectCmd(dir: string, pm: PM): Cmd | null {
	const pkgPath = path.join(dir, "package.json");
	if (!existsSync(pkgPath)) return null;

	const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
		scripts?: Record<string, string>;
		main?: string;
		dependencies?: Record<string, string>;
		devDependencies?: Record<string, string>;
	};
	const scripts = pkg.scripts ?? {};
	const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
	const hasVite = Object.keys(allDeps).some((k) => k === "vite" || k.includes("vite"));

	const run = (script: string, extraArgs: string[] = []): Cmd => ({
		bin: pm,
		args: ["run", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])],
		isVite: hasVite,
	});

	// Priority: start > preview (built) > dev > node main
	if (scripts.start) return run("start");
	if (scripts.preview && existsSync(path.join(dir, "dist"))) return run("preview");
	if (scripts.dev) return run("dev");
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

export async function startApp(relPath: string, absPath: string): Promise<{ port: number }> {
	const existing = apps.get(relPath);
	if (existing && existing.status !== "stopped" && existing.status !== "error") {
		return { port: existing.port };
	}

	const port = await findFreePort();
	const pm = detectPM(absPath);
	const cmd = detectCmd(absPath, pm);
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
