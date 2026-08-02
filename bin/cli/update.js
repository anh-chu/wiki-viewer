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
	const cmd = pm === "pnpm" ? ["pnpm", ["add", "-g", `${name}@latest`, "--prefer-offline"]]
			: pm === "yarn" ? ["yarn", ["global", "add", `${name}@latest`]]
			: ["npm", ["install", "-g", `${name}@latest`, "--prefer-offline"]];

	console.log(`Updating via ${pm}…`);
	try {
		execFileSync(cmd[0], cmd[1], { stdio: "inherit" });
	} catch {
		console.error(`Error: update failed. Try manually: ${cmd[0]} ${cmd[1].join(" ")}`);
		process.exit(1);
	}

	if (serviceIsInstalled()) {
		console.log("Restarting service…");
		try { serviceRestart(); console.log("Service restarted."); }
		catch { console.log("Note: could not restart service automatically. Run: wiki-viewer service restart"); }
	}
	console.log("Update complete.");
}
