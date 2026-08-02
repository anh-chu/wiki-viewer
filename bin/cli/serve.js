import { spawn, execFileSync, execSync } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer } from "node:net";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { makePrompter } from "./prompt.js";
import { configDir, loadConfig, parseEnvFlags } from "./config.js";
import {
	looksLikeSshTarget,
	parseSshTarget,
	buildSshfsArgs,
} from "../shared/ssh-target.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const appRoot = path.resolve(__dirname, "..", "..");
export const serverJs = path.join(appRoot, ".next", "standalone", "server.js");

// Env vars the app reads that the bin can derive or manage on the user's behalf.
// Everything else in config.env is passed through verbatim.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);

const mountsDir = path.join(configDir, "mounts");
let activeMount = null;

export function parseServeArgs(args) {
	let port = process.env.PORT;
	let host = process.env.HOSTNAME;
	let useHttps;
	let userSpecifiedPort = false;
	let userSpecifiedHost = false;
	let rootDir;
	let noAuth;
	let sshKey;
	let sshPort;
	let sshPassword;
	let sshReadOnly;

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-p" || a === "--port") { port = args[++i] ?? port; userSpecifiedPort = true; }
		else if (a === "-H" || a === "--host") { host = args[++i] ?? host; userSpecifiedHost = true; }
		else if (a === "-e" || a === "--env") { i++; } // consumed by parseEnvFlags
		else if (a === "--https") useHttps = true;
		else if (a === "--no-auth") noAuth = true;
		else if (a === "--ssh-key") sshKey = args[++i];
		else if (a === "--ssh-port") sshPort = args[++i];
		else if (a === "--ssh-password") sshPassword = true;
		else if (a === "--ssh-readonly") sshReadOnly = true;
		else if (!a.startsWith("-") && rootDir === undefined) rootDir = a;
	}

	return { rootDir, port, host, useHttps, userSpecifiedPort, userSpecifiedHost, noAuth, sshKey, sshPort, sshPassword: Boolean(sshPassword), sshReadOnly: Boolean(sshReadOnly) };
}

// ── ssh (sshfs) targets ──────────────────────────────────────────────────────
// Symmetry with the local-directory arg: `wiki-viewer user@host:/path` mounts a
// remote directory over sshfs and serves it as ROOT_DIR — no local clone. The
// mount is ephemeral (under ~/.wiki-viewer/mounts) and unmounted on exit. Auth:
// ssh-agent/host keys by default, --ssh-key <path>, or --ssh-password.

function isMountedSync(mp) {
	try {
		if (process.platform === "linux") {
			const m = readFileSync("/proc/mounts", "utf8");
			return m.split("\n").some((l) => { const p = l.split(" "); return p[1] === mp && /fuse/.test(p[2] || ""); });
		}
		const out = execFileSync("mount", [], { encoding: "utf8" });
		return out.split("\n").some((l) => l.includes(` on ${mp} `));
	} catch { return false; }
}

function unmountSync(mp) {
	const tries = process.platform === "linux"
		? [["fusermount", ["-u", "-z", mp]], ["umount", [mp]]]
		: [["umount", [mp]], ["diskutil", ["unmount", "force", mp]]];
	for (const [bin, a] of tries) { try { execFileSync(bin, a, { stdio: "ignore" }); break; } catch { /* try next */ } }
	try { rmSync(mp, { recursive: false, force: true }); } catch { /* best-effort */ }
}

function registerMountCleanup() {
	const cleanup = () => { if (activeMount) { const mp = activeMount; activeMount = null; unmountSync(mp); } };
	process.on("exit", cleanup);
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
		process.on(sig, () => { cleanup(); process.exit(0); });
	}
}

async function mountSshTarget({ targetStr, port, keyPath, password, readOnly }) {
	const target = parseSshTarget(targetStr);
	if (!target) {
		console.error(`Error: invalid SSH target '${targetStr}'. Use the form user@host:/abs/path.`);
		process.exit(1);
	}
	try { execFileSync("sshfs", ["--version"], { stdio: "ignore" }); }
	catch {
		console.error("Error: sshfs not found. Install sshfs + FUSE (e.g. `apt install sshfs`, `brew install macfuse sshfs`).");
		process.exit(1);
	}

	mkdirSync(mountsDir, { recursive: true });
	const mp = path.join(mountsDir, `cli-${process.pid}`);
	if (isMountedSync(mp)) unmountSync(mp);
	mkdirSync(mp, { recursive: true });

	const args = buildSshfsArgs({ target, mountpoint: mp, port, keyPath, password, readOnly });
	registerMountCleanup();
	await new Promise((resolve, reject) => {
		const child = spawn("sshfs", args, { stdio: ["pipe", "ignore", "pipe"] });
		let err = "";
		const t = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("sshfs mount timed out after 25s")); }, 25_000);
		child.stderr.on("data", (d) => { err += d.toString(); });
		child.on("error", (e) => { clearTimeout(t); reject(e); });
		child.on("close", (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error(err.trim() || `sshfs exited ${code}`)); });
		if (password != null) child.stdin.write(password + "\n");
		child.stdin.end();
	}).catch((e) => {
		console.error(`Error: sshfs mount failed: ${e.message}`);
		try { unmountSync(mp); } catch { /* ignore */ }
		process.exit(1);
	});

	if (!isMountedSync(mp)) {
		console.error("Error: sshfs reported success but the mount is not live.");
		unmountSync(mp);
		process.exit(1);
	}
	activeMount = mp;
	return mp;
}

async function promptLine(text) {
	const io = makePrompter();
	const ans = await io.prompt(text);
	io.close();
	return ans;
}

// ── config file ────────────────────────────────────────────────────────────

// Ad-hoc serve: CLI flags + built-in defaults. The run *shape* (dir/host/port)
// does NOT read the config file, so an installed service never silently alters
// a one-off invocation. App-level env (config.env) is still read, because those
// are settings about the app itself (allowlists, OAuth) rather than the bind.
export function resolveServeOptions(args) {
	const cli = parseServeArgs(args);
	const cfg = loadConfig();
	const isSsh = cli.rootDir != null && looksLikeSshTarget(cli.rootDir);
	return {
		rootDir: cli.rootDir && !isSsh ? path.resolve(cli.rootDir) : null,
		sshTarget: isSsh ? cli.rootDir : null,
		sshKey: cli.sshKey, sshPort: cli.sshPort, sshPassword: cli.sshPassword, sshReadOnly: cli.sshReadOnly,
		port: String(cli.port ?? "3000"),
		host: cli.host ?? "localhost",
		useHttps: Boolean(cli.useHttps),
		userSpecifiedPort: cli.userSpecifiedPort,
		configEnv: { ...(cfg.env ?? {}), ...(cli.noAuth ? { WIKI_NO_AUTH: "1" } : {}), ...parseEnvFlags(args) },
	};
}

// Service run: config file is the source of truth. CLI flags (if any) still win
// so the unit/plist could pass overrides, but normally there are none.
// Precedence: explicit CLI flags > config file > built-in defaults.
export function resolveRunOptions(args) {
	const cli = parseServeArgs(args);
	const cfg = loadConfig();

	const rootDir = cli.rootDir ?? cfg.rootDir ?? null;
	const port = cli.port ?? cfg.port ?? "3000";
	const host = cli.host ?? cfg.host ?? "localhost";
	const useHttps = cli.useHttps ?? cfg.https ?? false;
	const userSpecifiedPort = cli.userSpecifiedPort || cfg.port != null;

	const isSsh = rootDir != null && looksLikeSshTarget(rootDir);
	return {
		rootDir: rootDir && !isSsh ? path.resolve(rootDir) : null,
		sshTarget: isSsh ? rootDir : null,
		sshKey: cli.sshKey ?? cfg.ssh?.key,
		sshPort: cli.sshPort ?? cfg.ssh?.port,
		sshPassword: cli.sshPassword,
		sshReadOnly: cli.sshReadOnly || Boolean(cfg.ssh?.readOnly),
		port: String(port),
		host,
		useHttps: Boolean(useHttps),
		userSpecifiedPort,
		configEnv: { ...(cfg.env ?? {}), ...(cli.noAuth ? { WIKI_NO_AUTH: "1" } : {}), ...parseEnvFlags(args) },
	};
}

// ── environment resolution ───────────────────────────────────────────────────

export function isLocalHost(h) {
	return LOCAL_HOSTS.has(h);
}

// Build the env for the spawned server.
// Precedence (highest first):
//   1. the shell environment the user launched us with (explicit override)
//   2. config.env from ~/.wiki-viewer/config.json
//   3. values derived by the bin from the run options (e.g. BETTER_AUTH_URL)
export function computeServerEnv({ host, port, useHttps, configEnv }) {
	const warnings = [];
	const derived = {};

	const scheme = useHttps ? "https" : "http";
	const urlHost = isLocalHost(host) || host === "0.0.0.0" ? "localhost" : host;
	const isSecureContext = useHttps || isLocalHost(host);

	derived.BETTER_AUTH_URL = `${scheme}://${urlHost}:${port}`;

	if (!isSecureContext) {
		derived.WIKI_ALLOW_INSECURE = "1";
		warnings.push(
			`Serving plain HTTP on a non-local host (${host}). Browsers treat this as\n` +
			`   an insecure context: login cookies, service workers and PDF.js will not\n` +
			`   work reliably, and OAuth callbacks will fail.\n` +
			`   Fix: re-run with --https, or put a TLS-terminating proxy in front and set\n` +
			`   BETTER_AUTH_URL to its public https:// URL (see "env" in ${path.join(configDir, "config.json")}).`,
		);
	} else if (isLocalHost(host) && !useHttps) {
		derived.WIKI_ALLOW_INSECURE = "1";
	}

	const env = { ...derived, ...configEnv };

	// Note when the shell overrode a derived/config value so the user isn't
	// surprised that --host/--port didn't change the auth URL.
	if (process.env.BETTER_AUTH_URL && process.env.BETTER_AUTH_URL !== env.BETTER_AUTH_URL) {
		warnings.push(
			`BETTER_AUTH_URL is set in your shell (${process.env.BETTER_AUTH_URL}) and\n` +
			`   overrides the derived/config value.`,
		);
	}

	return { env, warnings };
}

// ── HTTPS cert generation ──────────────────────────────────────────────────

export function ensureCerts(host) {
	const dir = path.join(configDir, "certs");
	mkdirSync(dir, { recursive: true });
	const keyPath = path.join(dir, "key.pem");
	const certPath = path.join(dir, "cert.pem");
	if (existsSync(keyPath) && existsSync(certPath)) {
		return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
	}
	try {
		execSync("mkcert -version", { stdio: "ignore" });
		execSync(`mkcert -install 2>/dev/null; mkcert -key-file "${keyPath}" -cert-file "${certPath}" localhost 127.0.0.1 "${host}"`, { stdio: "pipe" });
		console.log("🔒  Trusted cert via mkcert");
	} catch {
		try {
			execSync(
				`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 825 -nodes -subj "/CN=localhost"`,
				{ stdio: "ignore" },
			);
			console.log("🔒  Self-signed cert (browser will warn once — click through)");
		} catch {
			console.error("Error: --https requires mkcert or openssl");
			process.exit(1);
		}
	}
	return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

// ── port availability helpers ──────────────────────────────────────────────

export function isPortAvailable(p, h) {
	return new Promise((resolve) => {
		const s = createNetServer();
		s.once("error", () => resolve(false));
		s.once("listening", () => s.close(() => resolve(true)));
		s.listen(Number(p), h);
	});
}

export async function findNextAvailablePort(startPort, h) {
	let p = Number(startPort);
	while (!(await isPortAvailable(p, h))) p++;
	return String(p);
}

export function freePort() {
	return new Promise((resolve) => {
		const s = createNetServer();
		s.listen(0, "127.0.0.1", () => {
			const { port: p } = s.address();
			s.close(() => resolve(p));
		});
	});
}

export function getNetworkAddress() {
	for (const ifaces of Object.values(os.networkInterfaces())) {
		for (const iface of ifaces ?? []) {
			if (iface.family === "IPv4" && !iface.internal) return iface.address;
		}
	}
	return null;
}

// ── start ──────────────────────────────────────────────────────────────────

export async function start(opts) {
	const { useHttps, configEnv = {} } = opts;
	let resolvedRoot = opts.rootDir;
	let { port, host, userSpecifiedPort } = opts;

	if (!existsSync(serverJs)) {
		console.error("Error: pre-built server not found at", serverJs);
		console.error("This is a bug – please report it at https://github.com/anh-chu/wiki-viewer/issues");
		process.exit(1);
	}

	// SSH target: mount it over sshfs and serve the mount point as ROOT_DIR.
	if (opts.sshTarget) {
		let password = null;
		if (opts.sshPassword) {
			password = process.env.WIKI_SSH_PASSWORD
				?? await promptLine(`SSH password for ${opts.sshTarget}: `);
		}
		console.log(`🔗  Mounting ${opts.sshTarget} over SSH…`);
		resolvedRoot = await mountSshTarget({
			targetStr: opts.sshTarget,
			port: opts.sshPort,
			keyPath: opts.sshKey,
			password,
			readOnly: opts.sshReadOnly,
		});
		console.log(`   mounted at ${resolvedRoot}${opts.sshReadOnly ? " (read-only)" : ""}`);
	}

	if (resolvedRoot) {
		console.log(`📂  ${resolvedRoot}`);
	} else {
		console.log("📂  No directory specified — open the browser to choose one");
	}

	// Auto-select next free port when user didn't specify one
	if (!userSpecifiedPort) {
		const available = await isPortAvailable(Number(port), host);
		if (!available) {
			const original = port;
			port = await findNextAvailablePort(Number(port) + 1, host);
			console.log(`⚠️   Port ${original} in use → using ${port} (pass -p <port> to override)`);
		}
	}

	const internalPort = useHttps ? String(await freePort()) : port;
	const internalHost = useHttps ? "127.0.0.1" : host;

	const { env: appEnv, warnings } = computeServerEnv({ host, port, useHttps, configEnv });
	for (const w of warnings) console.log(`\n⚠️   ${w}`);

	const child = spawn(process.execPath, [serverJs], {
		cwd: path.join(appRoot, ".next", "standalone"),
		stdio: "inherit",
		env: {
			...appEnv,
			...process.env,
			...(resolvedRoot ? { ROOT_DIR: resolvedRoot } : {}),
			PORT: internalPort,
			HOSTNAME: internalHost,
		},
	});

	child.on("exit", (code) => process.exit(code ?? 0));

	if (useHttps) {
		const { key, cert } = ensureCerts(host);

		const proxy = createHttpsServer({ key, cert }, (req, res) => {
			const options = {
				hostname: internalHost,
				port: Number(internalPort),
				path: req.url,
				method: req.method,
				headers: req.headers,
			};
			const upstream = httpRequest(options, (upRes) => {
				res.writeHead(upRes.statusCode, upRes.headers);
				upRes.pipe(res);
			});
			upstream.on("error", () => res.destroy());
			req.pipe(upstream);
		});

		setTimeout(() => {
			proxy.listen(Number(port), host, () => {
				const scheme = "https";
				const displayHost = host === "0.0.0.0" ? "localhost" : host;
				console.log(`\n  ➜  Local:   ${scheme}://${displayHost}:${port}`);
				const netAddr = getNetworkAddress();
				if (netAddr && host !== "localhost" && host !== "127.0.0.1") {
					console.log(`  ➜  Network: ${scheme}://${netAddr}:${port}`);
				}
				console.log(`\n  Listening on ${host}:${port}  (--host / -H, --port / -p to rebind)\n`);
			});
		}, 1_000);
	} else {
		const scheme = "http";
		const displayHost = host === "0.0.0.0" ? "localhost" : host;
		console.log(`\n  ➜  Local:   ${scheme}://${displayHost}:${port}`);
		const netAddr = getNetworkAddress();
		if (netAddr && host !== "localhost" && host !== "127.0.0.1") {
			console.log(`  ➜  Network: ${scheme}://${netAddr}:${port}`);
		}
		console.log(`\n  Listening on ${host}:${port}  (--host / -H, --port / -p to rebind)\n`);
	}
}
