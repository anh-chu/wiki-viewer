import path from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

export const configDir = path.join(os.homedir(), ".wiki-viewer");
export const configPath = path.join(configDir, "config.json");
export const logDir = path.join(configDir, "logs");

export function loadConfig() {
	if (!existsSync(configPath)) return {};
	try {
		return JSON.parse(readFileSync(configPath, "utf8"));
	} catch {
		console.error(`Warning: could not parse ${configPath}, ignoring it`);
		return {};
	}
}

export function saveConfig(cfg) {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

// Pull repeatable `--env KEY=VALUE` (or `-e KEY=VALUE`) pairs out of an argv
// list. Returns the collected map; the caller has already parsed the rest.
export function parseEnvFlags(args) {
	const env = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--env" || args[i] === "-e") {
			const pair = args[++i];
			if (!pair || !pair.includes("=")) {
				console.error(`Error: --env expects KEY=VALUE (got: ${pair ?? "(nothing)"})`);
				process.exit(1);
			}
			const idx = pair.indexOf("=");
			env[pair.slice(0, idx)] = pair.slice(idx + 1);
		}
	}
	return env;
}

export function configCommand(args) {
	const cfg = loadConfig();

	if (args.length === 0 || args[0] === "show" || args[0] === "list") {
		if (!existsSync(configPath)) {
			console.log(`No config yet at ${configPath}`);
			console.log(`Create one with: wiki-viewer service install [dir] [options] [--env KEY=VALUE]`);
			return;
		}
		console.log(configPath);
		console.log(JSON.stringify(cfg, null, 2));
		return;
	}

	if (args[0] === "set") {
		const pairs = args.slice(1);
		if (pairs.length === 0) {
			console.error("Usage: wiki-viewer config set KEY=VALUE [KEY=VALUE ...]");
			process.exit(1);
		}
		cfg.env = cfg.env ?? {};
		for (const pair of pairs) {
			const idx = pair.indexOf("=");
			if (idx < 0) { console.error(`Error: expected KEY=VALUE (got: ${pair})`); process.exit(1); }
			cfg.env[pair.slice(0, idx)] = pair.slice(idx + 1);
		}
		saveConfig(cfg);
		console.log(`Updated env in ${configPath}: ${pairs.map((p) => p.split("=")[0]).join(", ")}`);
		if (serviceIsInstalled()) console.log("Run `wiki-viewer service restart` to apply.");
		return;
	}

	if (args[0] === "unset") {
		const keys = args.slice(1);
		if (keys.length === 0) { console.error("Usage: wiki-viewer config unset KEY [KEY ...]"); process.exit(1); }
		cfg.env = cfg.env ?? {};
		for (const k of keys) delete cfg.env[k];
		saveConfig(cfg);
		console.log(`Removed from env: ${keys.join(", ")}`);
		if (serviceIsInstalled()) console.log("Run `wiki-viewer service restart` to apply.");
		return;
	}

	if (args[0] === "path") { console.log(configPath); return; }

	console.error(`Unknown config command: ${args[0]}`);
	console.error("Try: show | set KEY=VALUE | unset KEY | path");
	process.exit(1);
}

// configCommand needs to know whether a service is installed to prompt the user
// to restart it after an env change. Importing the full service module from
// config.js would create a circular dependency, so we keep a tiny local check.
function serviceIsInstalled() {
	const SERVICE_NAME = "wiki-viewer";
	const LAUNCHD_LABEL = "com.wiki-viewer";
	if (process.platform === "linux") {
		return existsSync(path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`));
	}
	if (process.platform === "darwin") {
		return existsSync(path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`));
	}
	return false;
}
