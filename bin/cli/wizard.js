import path from "node:path";
import { existsSync } from "node:fs";
import { loadConfig, saveConfig, configPath } from "./config.js";
import { makePrompter } from "./prompt.js";
import { computeServerEnv, start, resolveRunOptions, isLocalHost } from "./serve.js";
import {
	platform,
	requirePersistentInstall,
	resolveServiceNode,
	resolveServiceScript,
	versionManagedNodeWarning,
	installSystemd,
	installLaunchd,
} from "./service.js";

const WIZARD_ENV_VARS = [
	{ key: "AUTH_ALLOWED_DOMAIN", hint: "Restrict signup to an email domain, e.g. example.com" },
	{ key: "AUTH_ALLOWED_EMAILS", hint: "Restrict signup to specific emails (comma-separated)" },
	{ key: "GOOGLE_CLIENT_ID", hint: "Google OAuth client ID (enables Google sign-in)" },
	{ key: "GOOGLE_CLIENT_SECRET", hint: "Google OAuth client secret" },
	{ key: "AUTH_DISABLE_PASSWORD", hint: "Set to 1 to allow Google sign-in only (requires Google keys)" },
	{ key: "AUTH_TRUSTED_PROVIDERS", hint: "Auto-link these providers to existing accounts, e.g. google" },
	{ key: "WIKI_OWNER_HOSTS", hint: "Extra hostnames trusted for the AI panel owner cookie" },
	{ key: "AGENT_RATE_LIMIT", hint: "Per-minute agent API rate limit (default 60)" },
];

export async function runWizard() {
	const io = makePrompter();
	const existing = loadConfig();

	const ask = async (label, def) => {
		const suffix = def ? ` [${def}]` : "";
		const answer = (await io.prompt(`${label}${suffix}: `)).trim();
		return answer || def || "";
	};
	const askYesNo = async (label, defYes) => {
		const def = defYes ? "Y/n" : "y/N";
		const answer = (await io.prompt(`${label} [${def}]: `)).trim().toLowerCase();
		if (!answer) return defYes;
		return answer === "y" || answer === "yes";
	};

	try {
		console.log("\nwiki-viewer setup\n");
		console.log("Answer a few questions. Press Enter to accept the [default].\n");

		const dirInput = await ask(
			"Directory to serve (blank = choose later in the browser)",
			existing.rootDir ?? process.cwd(),
		);
		const rootDir = dirInput ? path.resolve(dirInput) : null;
		if (rootDir && !existsSync(rootDir)) {
			console.log(`  Note: ${rootDir} does not exist yet; it will be served once created.`);
		}

		const host = await ask(
			"Host to bind (localhost for this machine only, 0.0.0.0 for the network)",
			existing.host ?? "localhost",
		);

		const port = await ask("Port", String(existing.port ?? "3000"));

		const httpsDefault = existing.https ?? (!isLocalHost(host) && host !== "0.0.0.0");
		const useHttps = await askYesNo(
			"Enable HTTPS? (recommended for any non-localhost access)",
			Boolean(httpsDefault),
		);

		const env = { ...(existing.env ?? {}) };
		const wantEnv = await askYesNo(
			"\nConfigure app settings now? (OAuth, signup allowlist, rate limit)",
			false,
		);
		if (wantEnv) {
			console.log("Leave blank to skip a setting.\n");
			for (const { key, hint } of WIZARD_ENV_VARS) {
				const cur = env[key];
				const val = await ask(`  ${key} — ${hint}`, cur);
				if (val) env[key] = val;
				else delete env[key];
			}
		}

		const cfg = { ...existing, rootDir, host, port, https: useHttps };
		if (Object.keys(env).length) cfg.env = env;
		else delete cfg.env;

		console.log("\nConfiguration:");
		console.log(`  directory : ${rootDir ?? "(choose in browser)"}`);
		console.log(`  host      : ${host}`);
		console.log(`  port      : ${port}`);
		console.log(`  https     : ${useHttps}`);
		if (cfg.env) console.log(`  app env   : ${Object.keys(cfg.env).join(", ")}`);

		const { warnings } = computeServerEnv({ host, port: String(port), useHttps, configEnv: cfg.env ?? {} });
		for (const w of warnings) console.log(`\n⚠️   ${w}`);

		console.log("");
		console.log("What next?");
		console.log("  1) Install as a service (starts now and on every reboot)");
		console.log("  2) Run once now (foreground)");
		console.log("  3) Save config only");
		const choice = (await io.prompt("Choose [1/2/3]: ")).trim() || "1";

		saveConfig(cfg);
		console.log(`\nSaved ${configPath}`);

		io.close();

		if (choice === "1") {
			const p = platform();
			if (!p) {
				console.log("Service install is only supported on Linux and macOS.");
				console.log("Run it yourself with: wiki-viewer service run");
				return;
			}
			requirePersistentInstall();
			const nodeWarning = versionManagedNodeWarning(resolveServiceNode());
			if (nodeWarning) console.log(`\n⚠️   ${nodeWarning}\n`);
			const nodeBin = resolveServiceNode();
			const scriptPath = resolveServiceScript();
			if (p === "linux") installSystemd(nodeBin, scriptPath);
			else installLaunchd(nodeBin, scriptPath);
		} else if (choice === "2") {
			start(resolveRunOptions([]));
		} else {
			console.log("\nStart it any time with:");
			console.log("  wiki-viewer service install   # persistent service");
			console.log("  wiki-viewer service run       # run from this config");
		}
	} finally {
		io.close();
	}
}
