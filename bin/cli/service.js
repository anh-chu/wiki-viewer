import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { configPath, logDir, loadConfig, saveConfig, parseEnvFlags } from "./config.js";
import { computeServerEnv, parseServeArgs } from "./serve.js";
import { looksLikeSshTarget } from "../shared/ssh-target.js";

const selfScript = fileURLToPath(import.meta.url);

export const SERVICE_NAME = "wiki-viewer";
export const LAUNCHD_LABEL = "com.wiki-viewer";

export function platform() {
	if (process.platform === "linux") return "linux";
	if (process.platform === "darwin") return "macos";
	return null;
}

export function requireSupportedPlatform() {
	const p = platform();
	if (!p) {
		console.error(`Error: service management is only supported on Linux (systemd) and macOS (launchd), not ${process.platform}.`);
		process.exit(1);
	}
	return p;
}

export function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { stdio: "inherit", ...opts });
}

export function runQuiet(cmd, args) {
	try {
		return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
	} catch (e) {
		return null;
	}
}

export function installSystemd(nodeBin, scriptPath) {
	const unitDir = path.join(os.homedir(), ".config", "systemd", "user");
	mkdirSync(unitDir, { recursive: true });
	const unitPath = path.join(unitDir, `${SERVICE_NAME}.service`);

	const nodeDir = path.dirname(nodeBin);
	const sysPath = `${nodeDir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;
	const rgEnv = process.env.WIKI_VIEWER_RG
		? `\nEnvironment=WIKI_VIEWER_RG=${process.env.WIKI_VIEWER_RG}`
		: "";
	const unit = `[Unit]
Description=wiki-viewer local file viewer
After=network.target

[Service]
Type=simple
ExecStart=${nodeBin} ${scriptPath} service run
Restart=on-failure
RestartSec=3
Environment=NODE_ENV=production
Environment=PATH=${sysPath}${rgEnv}

[Install]
WantedBy=default.target
`;
	writeFileSync(unitPath, unit);
	console.log(`Wrote unit ${unitPath}`);

	const user = os.userInfo().username;
	try {
		execFileSync("loginctl", ["enable-linger", user], { stdio: "ignore" });
		console.log(`Enabled linger for ${user} (starts at boot)`);
	} catch {
		console.log(`Note: could not enable linger automatically. For boot persistence run:`);
		console.log(`  sudo loginctl enable-linger ${user}`);
	}

	run("systemctl", ["--user", "daemon-reload"]);
	run("systemctl", ["--user", "enable", "--now", `${SERVICE_NAME}.service`]);
	console.log("\nService installed and started.");
	console.log("  Status: wiki-viewer service status");
	console.log("  Logs:   wiki-viewer service logs");
}

export function installLaunchd(nodeBin, scriptPath) {
	const agentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
	mkdirSync(agentsDir, { recursive: true });
	mkdirSync(logDir, { recursive: true });
	const plistPath = path.join(agentsDir, `${LAUNCHD_LABEL}.plist`);
	const outLog = path.join(logDir, "out.log");
	const errLog = path.join(logDir, "err.log");

	const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${scriptPath}</string>
    <string>service</string>
    <string>run</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${outLog}</string>
  <key>StandardErrorPath</key>
  <string>${errLog}</string>
</dict>
</plist>
`;
	writeFileSync(plistPath, plist);
	console.log(`Wrote plist ${plistPath}`);

	runQuiet("launchctl", ["unload", plistPath]);
	run("launchctl", ["load", "-w", plistPath]);
	console.log("\nService installed and started.");
	console.log("  Status: wiki-viewer service status");
	console.log("  Logs:   wiki-viewer service logs");
}

// A persistent service bakes an absolute path to this script into the unit /
// plist (ExecStart). If we're running from a package-manager scratch cache
// (`npx wiki-viewer …`, `pnpm dlx …`, or an OS temp dir), that path is deleted
// the moment the cache is pruned, leaving a service that silently fails on the
// next reboot. Detect it and refuse, pointing the user at a global install.
export function ephemeralInstallReason() {
	const p = selfScript;
	const sep = path.sep;
	if (p.includes(`${sep}_npx${sep}`)) return "an npx cache";
	if (p.includes(`${sep}dlx-`)) return "a pnpm/yarn dlx cache";
	const tmp = os.tmpdir();
	if (p === tmp || p.startsWith(tmp + sep)) return "a temporary directory";
	return null;
}

export function requirePersistentInstall() {
	const reason = ephemeralInstallReason();
	if (!reason) return;
	console.error(`Error: cannot install a service from ${reason}.`);
	console.error(`  wiki-viewer is running from ${selfScript},`);
	console.error(`  which your package manager will delete. A service pointed there would`);
	console.error(`  break after the next cache cleanup or reboot.`);
	console.error(``);
	console.error(`  Install it globally first, then install the service:`);
	console.error(`    npm install -g ${SERVICE_NAME}`);
	console.error(`    ${SERVICE_NAME} service install ...`);
	process.exit(1);
}

function fnmRoot() {
	return process.env.FNM_DIR || path.join(os.homedir(), ".local", "share", "fnm");
}

export function resolveServiceNode() {
	const exec = process.execPath;
	const looksFnm = exec.includes("/fnm/") || exec.includes("/.fnm/") || exec.includes("fnm_multishells") || exec.includes("/fnm/node-versions/") || exec.includes("/.local/share/fnm/");
	if (looksFnm) {
		const fnmDefault = path.join(fnmRoot(), "aliases", "default", "bin", "node");
		if (existsSync(fnmDefault)) return fnmDefault;
	}
	return exec;
}

export function resolveServiceScript() {
	const script = selfScript;
	const pinned = path.join(fnmRoot(), "node-versions") + path.sep;
	if (!script.startsWith(pinned)) return script;
	const parts = path.relative(path.join(fnmRoot(), "node-versions"), script).split(path.sep);
	if (parts[1] !== "installation") return script;
	const durable = path.join(fnmRoot(), "aliases", "default", ...parts.slice(2));
	return existsSync(durable) ? durable : script;
}

export function versionManagedNodeWarning(nodePath) {
	const markers = ["/.nvm/", "/.asdf/", "/.volta/", "/n/versions/", "/fnm_multishells/", "/node-versions/"];
	if (!markers.some((m) => nodePath.includes(m))) return null;
	return (
		`The service will run Node from a version-manager path:\n` +
		`     ${nodePath}\n` +
		`   If you upgrade or remove that Node version, the service will stop working.\n` +
		`   Set a stable default (e.g. \`fnm default <version>\`) or install wiki-viewer\n` +
		`   under a system Node, then re-run the install.`
	);
}

export function serviceInstall(args) {
	const p = requireSupportedPlatform();
	requirePersistentInstall();

	const cli = parseServeArgs(args);
	const envFlags = parseEnvFlags(args);
	const existing = loadConfig();
	const mergedEnv = { ...(existing.env ?? {}), ...envFlags };
	const cliIsSsh = cli.rootDir != null && looksLikeSshTarget(cli.rootDir);

	const cfg = {
		...existing,
		rootDir: cli.rootDir != null
			? (cliIsSsh ? cli.rootDir : path.resolve(cli.rootDir))
			: existing.rootDir ?? null,
		host: cli.userSpecifiedHost ? cli.host : existing.host ?? "localhost",
		port: cli.userSpecifiedPort ? cli.port : existing.port ?? "3000",
		https: cli.useHttps ?? existing.https ?? false,
	};

	if (cliIsSsh) {
		cfg.ssh = { ...(cli.sshKey ? { key: cli.sshKey } : {}), ...(cli.sshPort ? { port: cli.sshPort } : {}), ...(cli.sshReadOnly ? { readOnly: true } : {}) };
	}
	if (Object.keys(mergedEnv).length) cfg.env = mergedEnv;
	else delete cfg.env;
	if (cliIsSsh && cli.sshPassword) {
		console.log("⚠️   --ssh-password is ignored for services (non-interactive). Use ssh-agent or --ssh-key.\n");
	}
	saveConfig(cfg);
	console.log(`Saved config to ${configPath}`);
	console.log(`  dir:   ${cfg.rootDir ?? "(choose in browser)"}`);
	console.log(`  host:  ${cfg.host}`);
	console.log(`  port:  ${cfg.port}`);
	console.log(`  https: ${cfg.https}`);
	if (cfg.env) {
		console.log(`  env:   ${Object.keys(cfg.env).join(", ")}`);
	}
	console.log("");

	const { warnings } = computeServerEnv({ host: cfg.host, port: String(cfg.port), useHttps: Boolean(cfg.https), configEnv: cfg.env ?? {} });
	for (const w of warnings) console.log(`\n⚠️   ${w}\n`);

	const nodeWarning = versionManagedNodeWarning(resolveServiceNode());
	if (nodeWarning) console.log(`⚠️   ${nodeWarning}\n`);

	const nodeBin = resolveServiceNode();
	const scriptPath = resolveServiceScript();
	if (p === "linux") installSystemd(nodeBin, scriptPath);
	else installLaunchd(nodeBin, scriptPath);
}

export function serviceUninstall() {
	const p = requireSupportedPlatform();
	if (p === "linux") {
		runQuiet("systemctl", ["--user", "disable", "--now", `${SERVICE_NAME}.service`]);
		const unitPath = path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
		if (existsSync(unitPath)) { rmSync(unitPath); console.log(`Removed ${unitPath}`); }
		runQuiet("systemctl", ["--user", "daemon-reload"]);
	} else {
		const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
		runQuiet("launchctl", ["unload", "-w", plistPath]);
		if (existsSync(plistPath)) { rmSync(plistPath); console.log(`Removed ${plistPath}`); }
	}
	console.log("Service uninstalled.");
}

export function serviceStatus() {
	const p = platform();
	if (p === "linux") {
		try { run("systemctl", ["--user", "status", `${SERVICE_NAME}.service`, "--no-pager"]); }
		catch { /* systemctl exits non-zero when inactive; output already shown */ }
	} else if (p === "macos") {
		const out = runQuiet("launchctl", ["list"]);
		if (out) {
			const line = out.split("\n").find((l) => l.includes(LAUNCHD_LABEL));
			console.log(line ? line.trim() : `${LAUNCHD_LABEL}: not loaded`);
		}
	}
}

export function serviceLogs() {
	const p = platform();
	if (p === "linux") {
		run("journalctl", ["--user", "-u", `${SERVICE_NAME}.service`, "-n", "100", "-f"]);
	} else if (p === "macos") {
		const outLog = path.join(logDir, "out.log");
		const errLog = path.join(logDir, "err.log");
		run("tail", ["-n", "100", "-f", outLog, errLog]);
	}
}

export function serviceIsInstalled() {
	const p = platform();
	if (p === "linux") {
		return existsSync(path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`));
	}
	if (p === "macos") {
		return existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
	}
	return false;
}

export function serviceRestart() {
	const p = platform();
	if (p === "linux") {
		run("systemctl", ["--user", "restart", `${SERVICE_NAME}.service`]);
	} else if (p === "macos") {
		const plistPath = path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
		runQuiet("launchctl", ["unload", plistPath]);
		run("launchctl", ["load", "-w", plistPath]);
	}
}
