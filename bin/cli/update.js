import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { appRoot } from "./serve.js";
import { serviceIsInstalled, serviceRestart } from "./service.js";

const selfScript = fileURLToPath(import.meta.url);

export function detectPackageManager() {
	const ua = process.env.npm_config_user_agent ?? "";
	if (ua.startsWith("pnpm")) return "pnpm";
	if (ua.startsWith("yarn")) return "yarn";
	if (selfScript.includes(`${path.sep}pnpm${path.sep}`)) return "pnpm";
	return "npm";
}

export function runQuiet(cmd, args) {
	try {
		return execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }).toString();
	} catch (e) {
		return null;
	}
}

export function update() {
	const pkg = JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8"));
	const name = pkg.name;
	console.log(`Current ${name}: v${pkg.version}`);

	const latest = (runQuiet("npm", ["view", `${name}@latest`, "version"]) || "").trim();
	if (latest && latest === pkg.version) {
		console.log(`Already on the latest version (v${latest}). Nothing to do.`);
		return;
	}
	if (latest) console.log(`Latest: v${latest}`);

	const pm = detectPackageManager();
	// Pin the exact resolved version (not the @latest dist-tag) and skip
	// --prefer-offline: both npm and pnpm can serve a stale cached packument
	// under offline-preference, which resolves the dependency graph correctly
	// but then skips re-extracting files because the cache believes the
	// requested version is already satisfied — leaving the old binary in
	// place while printing a successful install. Installing an exact pinned
	// version avoids relying on dist-tag/offline resolution altogether.
	const target = latest ? `${name}@${latest}` : `${name}@latest`;
	const cmd = pm === "pnpm" ? ["pnpm", ["add", "-g", target]]
			: pm === "yarn" ? ["yarn", ["global", "add", target]]
			: ["npm", ["install", "-g", target]];

	console.log(`Updating via ${pm}…`);
	const runInstall = (extraArgs = []) => execFileSync(cmd[0], [...cmd[1], ...extraArgs], { stdio: "inherit" });
	try {
		runInstall();
	} catch {
		console.error(`Error: update failed. Try manually: ${cmd[0]} ${cmd[1].join(" ")}`);
		process.exit(1);
	}

	// Verify the install actually landed. If the on-disk version still
	// doesn't match what we asked for, the package manager likely skipped
	// the real file write (stale cache/idempotency short-circuit) despite
	// reporting success — retry once with --force to bypass that.
	const readInstalledVersion = () => {
		try {
			return JSON.parse(readFileSync(path.join(appRoot, "package.json"), "utf8")).version;
		} catch {
			return null;
		}
	};
	let installedVersion = readInstalledVersion();
	if (latest && installedVersion !== latest) {
		console.log("Install did not take effect on first attempt — retrying with --force…");
		try {
			runInstall(["--force"]);
		} catch {
			console.error(`Error: forced update failed. Try manually: ${cmd[0]} ${cmd[1].join(" ")} --force`);
			process.exit(1);
		}
		installedVersion = readInstalledVersion();
		if (latest && installedVersion !== latest) {
			console.error(
				`Error: update reported success but v${installedVersion ?? "unknown"} is installed, not v${latest}. ` +
					`Try manually: ${cmd[0]} ${cmd[1].join(" ")} --force`,
			);
			process.exit(1);
		}
	}

	if (serviceIsInstalled()) {
		console.log("Restarting service…");
		try { serviceRestart(); console.log("Service restarted."); }
		catch { console.log("Note: could not restart service automatically. Run: wiki-viewer service restart"); }
	}
	console.log("Update complete.");
}
